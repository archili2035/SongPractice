const scriptUrl = document.currentScript.src;
const byId = id => document.getElementById(id);
const inputs = {
    vocal: byId('vocal-file'),
    backing: byId('backing-file'),
    guide: byId('guide-file'),
};
const tracks = { vocal: null, backing: null, guide: null };
const offsets = { vocal: byId('vocal-offset'), guide: byId('guide-offset') };
const names = { vocal: '人声', backing: '伴奏', guide: '参考旋律' };
const position = byId('position');
const playButton = byId('play');
const recordButton = byId('record');
const mixControl = byId('mix');
const canvas = byId('chart');
const brush = canvas.getContext('2d');
const palette = getComputedStyle(canvas);
const status = byId('status');

let context;
let worker;
let workletReady;
let playback;
let recording;
let requestingMic = false;
let downloadUrl;
let nextJob = 0;
const jobs = new Map();
const loads = new Map();

function audioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('此浏览器不支持 Web Audio。');
    context ??= new AudioContextClass();
    return context;
}

function bounded(input) {
    const value = input.valueAsNumber;
    return Number.isFinite(value) ? Math.max(Number(input.min), Math.min(Number(input.max), value)) : 0;
}

function offset(kind) {
    return offsets[kind] ? bounded(offsets[kind]) : 0;
}

function endTime(kinds = Object.keys(tracks)) {
    return Math.max(0, ...kinds.map(kind => tracks[kind] ? tracks[kind].buffer.duration + offset(kind) : 0));
}

function activeKinds() {
    return mixControl.value === 'mix' ? ['vocal', 'backing'] : [mixControl.value];
}

function timestamp(seconds, precise = false) {
    const ticks = Math.round(Math.max(0, seconds) * (precise ? 100 : 1));
    const units = precise ? 100 : 1;
    const minutes = Math.floor(ticks / (60 * units));
    const wholeSeconds = String(Math.floor(ticks / units) % 60).padStart(2, '0');
    const fraction = precise ? `.${String(ticks % 100).padStart(2, '0')}` : '';
    return `${minutes}:${wholeSeconds}${fraction}`;
}

function noteName(midi) {
    const note = Math.round(midi);
    const chromatic = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
    return `${chromatic[(note % 12 + 12) % 12]}${Math.floor(note / 12) - 1}`;
}

function updateTransport() {
    const locked = Boolean(requestingMic || recording);
    const end = endTime();
    position.max = String(end);
    position.disabled = locked || !end;
    playButton.disabled = locked || !endTime(activeKinds());
    mixControl.disabled = locked;
    for (const input of [...Object.values(inputs), ...Object.values(offsets)]) input.disabled = locked;
    for (const kind of Object.keys(inputs)) {
        const button = byId(`${kind}-remove`);
        button.hidden = !tracks[kind];
        button.disabled = locked;
    }
    byId('demo').disabled = locked;
    recordButton.disabled = requestingMic || Boolean(recording?.stopping);
    recordButton.textContent = recording ? (recording.stopping ? '正在结束录音…' : '结束录音') : '开始录音';
    showPosition(Number(position.value));
}

function showPosition(time) {
    const end = endTime();
    position.value = String(Math.min(end, Math.max(time, 0)));
    position.setAttribute('aria-valuetext', timestamp(Number(position.value)));
    byId('time').textContent = `${timestamp(Number(position.value))} / ${timestamp(end)}`;
    drawChart();
}

function makeSource(audio, when, timelineStart, kind, volume) {
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    const trackStart = offset(kind);
    const skip = Math.max(0, timelineStart - trackStart);
    source.buffer = tracks[kind].buffer;
    if (skip >= source.buffer.duration) return null;
    gain.gain.value = volume;
    source.connect(gain).connect(audio.destination);
    source.onended = () => {
        source.disconnect();
        gain.disconnect();
    };
    source.start(when + Math.max(0, trackStart - timelineStart), skip);
    return source;
}

function stopPlayback() {
    if (!playback) return;
    const previous = playback;
    playback = null;
    cancelAnimationFrame(previous.animation);
    for (const source of previous.sources) source.stop();
    playButton.textContent = '播放';
}

function tickPlayback() {
    if (!playback) return;
    const now = playback.start + Math.max(0, context.currentTime - playback.when);
    if (now >= playback.end) {
        showPosition(playback.end);
        stopPlayback();
        return;
    }
    showPosition(now);
    playback.animation = requestAnimationFrame(tickPlayback);
}

async function play() {
    const audio = audioContext();
    await audio.resume();
    if (recording || requestingMic || playback) return;
    const kinds = activeKinds().filter(kind => tracks[kind]);
    const end = endTime(kinds);
    if (!end) return;
    const cursor = Number(position.value);
    const start = cursor < end - 0.01 ? cursor : 0;
    const when = audio.currentTime + 0.04;
    const sources = kinds.map(kind => makeSource(audio, when, start, kind,
        kinds.length > 1 ? (kind === 'backing' ? 0.36 : 0.64) : 1)).filter(Boolean);
    playback = { when, start, end, sources, animation: 0 };
    playButton.textContent = '暂停';
    tickPlayback();
}

function monoSamples(buffer) {
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    return Float32Array.from(left, (value, i) => (value + right[i]) / 2);
}

function analyze(kind, track) {
    if (!worker) {
        worker = new Worker(new URL('pitch-worker.js', scriptUrl));
        worker.onmessage = ({ data: { id, frames, notes, error } }) => {
            const job = jobs.get(id);
            jobs.delete(id);
            if (!job || tracks[job.kind] !== job.track) return;
            job.track.analysis = error ? 'error' : { frames, notes };
            renderResults();
        };
        worker.onerror = () => {
            for (const { track: pending } of jobs.values()) pending.analysis = 'error';
            jobs.clear();
            worker.terminate();
            worker = null;
            renderResults();
        };
    }
    const id = ++nextJob;
    const samples = monoSamples(track.buffer);
    jobs.set(id, { kind, track });
    worker.postMessage({ id, samples, sampleRate: track.buffer.sampleRate }, [samples.buffer]);
}

function setTrack(kind, buffer) {
    if (kind === 'vocal') clearDownload();
    const track = { buffer, analysis: null };
    tracks[kind] = track;
    if (kind !== 'backing') {
        try {
            analyze(kind, track);
        } catch {
            track.analysis = 'error';
        }
    }
}

function removeTrack(kind) {
    loads.delete(kind);
    tracks[kind] = null;
    if (kind === 'vocal') clearDownload();
    if (offsets[kind]) offsets[kind].value = '0';
    inputs[kind].value = '';
    if (!endTime(activeKinds())) mixControl.value = tracks.vocal || tracks.backing ? 'mix' : 'guide';
}

async function loadTrack(kind, file) {
    if (!file) return;
    const job = Symbol();
    loads.set(kind, job);
    status.textContent = `正在读取${names[kind]}…`;
    try {
        if (file.size > 100 * 1024 ** 2) throw new Error('请选择不超过 100 MB 的音频。');
        const buffer = await audioContext().decodeAudioData(await file.arrayBuffer());
        if (buffer.duration > 600) throw new Error('请选择不超过 10 分钟的音频。');
        if (loads.get(kind) !== job) return;
        stopPlayback();
        if (offsets[kind]) offsets[kind].value = '0';
        setTrack(kind, buffer);
        if (kind === 'backing') mixControl.value = 'mix';
        if (!endTime(activeKinds())) mixControl.value = kind;
        status.textContent = `已读取${names[kind]} ${file.name}（${timestamp(buffer.duration)}）。`;
        updateTransport();
        renderResults();
    } catch (error) {
        if (loads.get(kind) !== job) return;
        inputs[kind].value = '';
        status.textContent = error.name === 'EncodingError' || error.name === 'NotSupportedError'
            ? '浏览器无法解码此音频。可以尝试 WAV 或 MP3。' : error.message || '无法打开音频文件。';
    }
}

function clearDownload() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    byId('download').hidden = true;
    byId('download').removeAttribute('href');
}

function waveBlob(buffer) {
    const samples = buffer.getChannelData(0);
    const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
    for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) {
        [...value].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
    }
    view.setUint32(4, view.byteLength - 8, true);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, sample * (sample < 0 ? 32768 : 32767), true);
    }
    return new Blob([view.buffer], { type: 'audio/wav' });
}

function finishRecording(session) {
    if (recording !== session) return;
    recording = null;
    clearTimeout(session.stopTimer);
    session.backing?.stop();
    session.stream.getTracks().forEach(track => track.stop());
    session.input.disconnect();
    session.node.disconnect();
    session.node.port.close();
    try {
        const length = session.blocks.reduce((sum, block) => sum + block.length, 0);
        if (!length) throw new Error('这次没有采集到录音，请再试一次。');
        const buffer = context.createBuffer(1, length, context.sampleRate);
        let index = 0;
        for (const block of session.blocks) {
            buffer.copyToChannel(block, 0, index);
            index += block.length;
        }
        offsets.vocal.value = '0';
        inputs.vocal.value = '';
        setTrack('vocal', buffer);
        downloadUrl = URL.createObjectURL(waveBlob(buffer));
        byId('download').href = downloadUrl;
        byId('download').hidden = false;
        mixControl.value = 'mix';
        position.value = '0';
        status.textContent = '录音完成。若设备延迟影响入拍结果，可在对齐设置里微调人声。';
    } catch (error) {
        status.textContent = error.message || '无法结束录音。';
    }
    updateTransport();
    renderResults();
}

function stopRecording() {
    if (!recording || recording.stopping) return;
    const session = recording;
    session.stopping = true;
    session.node.port.postMessage('stop');
    session.stopTimer = setTimeout(() => finishRecording(session), 1200);
    updateTransport();
}

async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
        status.textContent = '请用 HTTPS 或 localhost 打开此页并允许麦克风，或直接导入现有录音。';
        return;
    }
    stopPlayback();
    loads.clear();
    requestingMic = true;
    updateTransport();
    status.textContent = '等待麦克风权限…';
    let stream;
    try {
        const audio = audioContext();
        await audio.resume();
        workletReady ??= audio.audioWorklet.addModule(new URL('practice-recorder.js', scriptUrl)).catch(error => {
            workletReady = null;
            throw error;
        });
        await workletReady;
        stream = await navigator.mediaDevices.getUserMedia({ audio: {
            channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        } });
        await audio.resume();
        const firstFrame = Math.ceil((audio.currentTime + 0.28) * audio.sampleRate);
        const input = audio.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(audio, 'practice-recorder', {
            channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
            processorOptions: { firstFrame },
        });
        const session = { stream, input, node, blocks: [] };
        recording = session;
        node.port.onmessage = ({ data }) => {
            if (recording !== session) return;
            if (data === 'done') finishRecording(session);
            else session.blocks.push(data);
        };
        node.onprocessorerror = () => finishRecording(session);
        stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
            if (recording === session) stopRecording();
        }, { once: true }));
        input.connect(node).connect(audio.destination);
        if (tracks.backing) session.backing = makeSource(audio, firstFrame / audio.sampleRate, 0, 'backing', 0.65);
        status.textContent = tracks.backing ? '正在录音，伴奏从头播放。' : '正在录音，可以开始唱。';
    } catch (error) {
        if (recording) finishRecording(recording);
        else stream?.getTracks().forEach(track => track.stop());
        status.textContent = error.name === 'NotAllowedError' ? '麦克风权限未开启。仍可导入录音。' : '无法启动麦克风录音。仍可导入本地录音。';
    } finally {
        requestingMic = false;
        updateTransport();
    }
}

function timedNotes(kind) {
    const shift = offset(kind);
    return (tracks[kind]?.analysis?.notes || []).map(note => ({
        start: note.start + shift, end: note.end + shift, midi: note.midi,
    })).filter(note => note.end > 0);
}

function compareNotes(sung, reference) {
    const rows = [];
    let index = 0;
    for (const target of reference) {
        const tolerance = Math.min(0.48, Math.max(0.16, (target.end - target.start) * 0.85));
        while (index < sung.length && sung[index].start < target.start - tolerance) index++;
        let choice = -1;
        let cost = Infinity;
        for (let i = index; i < sung.length && sung[i].start <= target.start + tolerance; i++) {
            const note = sung[i];
            const distance = Math.abs(note.start - target.start) / tolerance;
            const interval = Math.min(3, Math.abs(note.midi - Math.round(target.midi)));
            const penalty = distance + 0.13 * interval;
            if (penalty < cost) {
                choice = i;
                cost = penalty;
            }
        }
        const note = sung[choice];
        const midi = Math.round(target.midi);
        rows.push({
            start: note?.start ?? target.start,
            actual: note ? noteName(note.midi) : '未匹配',
            target: noteName(midi),
            cents: note ? 100 * (note.midi - midi) : null,
            timeDelta: note ? 1000 * (note.start - target.start) : null,
        });
        if (note) index = choice + 1;
    }
    return rows;
}

function signed(value, unit, positive, negative) {
    if (value === null) return '—';
    const rounded = Math.round(Math.abs(value));
    if (!rounded) return `0 ${unit}`;
    return `${value > 0 ? positive : negative} ${rounded} ${unit}`;
}

function renderResults() {
    drawChart();
    const summary = byId('summary');
    const results = byId('note-results');
    results.hidden = true;
    byId('guide-legend').hidden = !tracks.guide?.analysis?.notes?.length;
    if (!tracks.vocal) {
        summary.textContent = '导入人声或完成录音后，查看逐音结果。';
        return;
    }
    if (tracks.vocal.analysis === 'error') {
        summary.textContent = '无法运行音高分析。请通过 HTTPS 或 localhost 打开，或尝试重新导入。';
        return;
    }
    if (!tracks.vocal.analysis || (tracks.guide && !tracks.guide.analysis)) {
        summary.textContent = '正在检测基频和起声位置…';
        return;
    }
    const sung = timedNotes('vocal');
    if (!sung.length) {
        summary.textContent = '没有检测到可分析的稳定音。可尝试音量适中的清唱录音。';
        return;
    }
    const reference = timedNotes('guide');
    const bpm = bounded(byId('bpm'));
    const beatTime = 60 / bpm;
    const firstBeat = bounded(byId('first-beat'));
    const rows = reference.length ? compareNotes(sung, reference) : sung.map(note => {
        const beats = (note.start - firstBeat) / beatTime;
        const beatDelta = bpm && note.start >= firstBeat - beatTime / 2 ? 1000 * (beats - Math.max(0, Math.round(beats))) * beatTime : null;
        return {
            start: note.start, actual: noteName(note.midi), target: '—',
            cents: 100 * (note.midi - Math.round(note.midi)), timeDelta: beatDelta,
        };
    });
    if (reference.length) {
        const paired = rows.filter(row => row.cents !== null);
        summary.textContent = `匹配 ${paired.length} / ${rows.length} 个参考音。${paired.filter(row => Math.abs(row.cents) <= 35).length} 个匹配音在目标音的 ±35 音分内。`;
    } else {
        const guideHint = tracks.guide ? '参考音频里没有可用的稳定音。' : '';
        const beatHint = bpm ? ' 起声偏差按最近一拍估算，切分和反拍也会显示偏离。' : ' 加入参考旋律或设置 BPM 可查看入拍。';
        summary.textContent = `${guideHint}检测到 ${rows.length} 个稳定音。音高偏差相对最近的半音。${beatHint}`;
    }
    const body = byId('notes');
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
        const tr = document.createElement('tr');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'seek-note';
        button.textContent = timestamp(row.start, true);
        button.dataset.time = String(row.start);
        tr.insertCell().append(button);
        for (const value of [row.actual, row.target, signed(row.cents, '音分', '偏高', '偏低'), signed(row.timeDelta, '毫秒', '晚', '早')]) {
            tr.insertCell().textContent = value;
        }
        fragment.append(tr);
    }
    body.replaceChildren(fragment);
    results.hidden = false;
}

function chartRange() {
    const cursor = Number(position.value);
    const duration = endTime();
    const span = Math.max(1, Math.min(12, duration));
    return { cursor, span, start: Math.max(0, Math.min(cursor - 3, duration - span)) };
}

function drawChart() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!brush || !width || !height) return;
    const pixelRatio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
    }
    brush.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    brush.clearRect(0, 0, width, height);
    const ink = palette.getPropertyValue('--ink-secondary');
    brush.font = `${palette.getPropertyValue('--text-micro')} ${palette.getPropertyValue('--font-sans')}`;
    const { cursor, start, span } = chartRange();
    const shift = offset('vocal');
    const frames = (tracks.vocal?.analysis?.frames || []).filter(frame => frame.time + shift >= start && frame.time + shift <= start + span);
    const reference = timedNotes('guide').filter(note => note.start <= start + span && note.end >= start);
    if (!frames.length && !reference.length) {
        brush.fillStyle = ink;
        brush.textAlign = 'center';
        brush.fillText('等待音高数据', width / 2, height / 2);
        return;
    }
    const pitches = [...frames.map(frame => frame.midi), ...reference.map(note => note.midi)];
    const low = Math.floor(Math.min(...pitches)) - 1;
    const high = Math.max(low + 6, Math.ceil(Math.max(...pitches)) + 1);
    const left = 41;
    const plotWidth = width - left - 12;
    const plotHeight = height - 36;
    const x = time => left + (time - start) * plotWidth / span;
    const y = midi => 12 + (high - midi) * plotHeight / (high - low);
    brush.lineWidth = 1;
    brush.strokeStyle = palette.getPropertyValue('--hairline');
    brush.fillStyle = ink;
    brush.textAlign = 'right';
    for (let midi = low; midi <= high; midi += Math.max(1, Math.ceil((high - low) / 8))) {
        brush.beginPath();
        brush.moveTo(left, y(midi));
        brush.lineTo(left + plotWidth, y(midi));
        brush.stroke();
        brush.fillText(noteName(midi), left - 5, y(midi) + 4);
    }
    brush.textAlign = 'center';
    for (let step = 0; step <= 4; step++) {
        const time = start + span * step / 4;
        brush.fillText(timestamp(time), Math.min(width - 17, x(time)), height - 7);
    }
    brush.strokeStyle = palette.getPropertyValue('--info');
    brush.lineWidth = 4;
    for (const note of reference) {
        brush.beginPath();
        brush.moveTo(x(Math.max(start, note.start)), y(Math.round(note.midi)));
        brush.lineTo(x(Math.min(start + span, note.end)), y(Math.round(note.midi)));
        brush.stroke();
    }
    brush.strokeStyle = palette.getPropertyValue('--accent');
    brush.lineWidth = 2;
    brush.beginPath();
    let previous;
    for (const frame of frames) {
        if (!previous || frame.time - previous.time > 0.05 || Math.abs(frame.midi - previous.midi) > 7) {
            brush.moveTo(x(frame.time + shift), y(frame.midi));
        } else {
            brush.lineTo(x(frame.time + shift), y(frame.midi));
        }
        previous = frame;
    }
    brush.stroke();
    brush.strokeStyle = ink;
    brush.lineWidth = 1;
    brush.beginPath();
    brush.moveTo(x(cursor), 8);
    brush.lineTo(x(cursor), height - 22);
    brush.stroke();
}

function demoBuffer(audio, notes) {
    const buffer = audio.createBuffer(1, 6 * audio.sampleRate, audio.sampleRate);
    const samples = buffer.getChannelData(0);
    for (const [time, midi, duration, volume] of notes) {
        const rate = audio.sampleRate;
        const onset = Math.round(time * rate);
        const length = Math.round(duration * rate);
        const frequency = 440 * 2 ** ((midi - 69) / 12);
        for (let i = 0; i < length; i++) {
            const envelope = Math.min(1, i / (rate * 0.009), (length - i) / (rate * 0.02));
            samples[onset + i] += volume * envelope * Math.sin(2 * Math.PI * frequency * i / rate);
        }
    }
    return buffer;
}

function loadDemo() {
    const audio = audioContext();
    stopPlayback();
    loads.clear();
    Object.values(inputs).forEach(input => { input.value = ''; });
    Object.values(offsets).forEach(input => { input.value = '0'; });
    const melody = [52, 54, 56, 59, 56, 54, 52].map((midi, index) => [0.55 + index * 0.65, midi, 0.45, 0.3]);
    const deviations = [0.3, -0.34, 0, 0.17, 0, -0.25, 0];
    setTrack('guide', demoBuffer(audio, melody));
    setTrack('vocal', demoBuffer(audio, melody.map(([time, midi, duration, volume], index) =>
        [time + 0.11, midi + deviations[index], duration, volume])));
    setTrack('backing', demoBuffer(audio, melody.map(([time]) => [time, 88, 0.035, 0.24])));
    mixControl.value = 'mix';
    position.value = '0';
    status.textContent = '已加载合成示例，包含示范、人声音轨与节拍音。';
    updateTransport();
    renderResults();
}

for (const [kind, input] of Object.entries(inputs)) {
    input.addEventListener('change', () => loadTrack(kind, input.files[0]));
    byId(`${kind}-remove`).addEventListener('click', () => {
        stopPlayback();
        removeTrack(kind);
        status.textContent = `已移除${names[kind]}。`;
        updateTransport();
        renderResults();
    });
}
for (const control of [...Object.values(offsets), byId('bpm'), byId('first-beat')]) {
    control.addEventListener('input', () => {
        stopPlayback();
        updateTransport();
        renderResults();
    });
}
mixControl.addEventListener('change', () => {
    stopPlayback();
    updateTransport();
});
position.addEventListener('input', () => {
    stopPlayback();
    showPosition(Number(position.value));
});
playButton.addEventListener('click', () => {
    if (playback) stopPlayback();
    else play().catch(() => { status.textContent = '无法播放音频，请重试。'; });
});
recordButton.addEventListener('click', () => {
    if (recording) stopRecording();
    else startRecording();
});
byId('demo').addEventListener('click', () => {
    try {
        loadDemo();
    } catch (error) {
        status.textContent = error.message || '无法加载示例。';
    }
});
byId('notes').addEventListener('click', event => {
    const time = event.target.closest('button')?.dataset.time;
    if (time === undefined || recording || requestingMic) return;
    stopPlayback();
    showPosition(Number(time) - 0.15);
    play().catch(() => { status.textContent = '无法播放这个片段。'; });
});
window.addEventListener('resize', drawChart);
window.addEventListener('pagehide', () => {
    stopPlayback();
    recording?.stream.getTracks().forEach(track => track.stop());
    stopRecording();
});
updateTransport();
