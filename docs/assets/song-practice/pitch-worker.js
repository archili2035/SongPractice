const analysisRate = 8000;
const hop = 128;
const windowSize = 384;
const minLag = Math.floor(analysisRate / 1200);
const maxLag = Math.ceil(analysisRate / 60);

function downsample(samples, sampleRate) {
    const ratio = sampleRate / analysisRate;
    const output = new Float32Array(Math.floor(samples.length / ratio));
    for (let index = 0; index < output.length; index++) {
        const start = Math.floor(index * ratio);
        const end = Math.floor((index + 1) * ratio);
        let sum = 0;
        for (let sample = start; sample < end; sample++) sum += samples[sample];
        output[index] = sum / (end - start);
    }
    return output;
}

function pitchAt(samples, center, difference) {
    const start = Math.max(0, center - Math.floor((windowSize + maxLag) / 2));
    if (start + windowSize + maxLag >= samples.length) return null;
    let power = 0;
    for (let i = center; i < center + hop; i++) power += samples[i] ** 2;
    if (power < hop * 0.003 ** 2) return null;

    let runningSum = 0;
    difference[0] = 1;
    let lag = 0;
    for (let offset = 1; offset <= maxLag; offset++) {
        let sum = 0;
        for (let i = start; i < start + windowSize; i++) {
            const delta = samples[i] - samples[i + offset];
            sum += delta * delta;
        }
        runningSum += sum;
        difference[offset] = runningSum > 0 ? sum * offset / runningSum : 1;
        if (offset > minLag && difference[offset - 1] < 0.18 && difference[offset] >= difference[offset - 1]) {
            lag = offset - 1;
            break;
        }
    }
    if (!lag) return null;
    const left = difference[lag - 1];
    const centerValue = difference[lag];
    const right = difference[lag + 1];
    const curvature = left - 2 * centerValue + right;
    const refined = curvature ? lag + (left - right) / (2 * curvature) : lag;
    return 69 + 12 * Math.log2(analysisRate / refined / 440);
}

function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function groupNotes(frames) {
    const notes = [];
    const minimumFrames = 5;
    let run = [];
    let key = null;

    function finish() {
        if (run.length >= minimumFrames) {
            const trim = Math.floor(run.length / 5);
            const stable = run.slice(trim, run.length - trim);
            notes.push({
                start: run[0].time,
                end: run.at(-1).time + hop / analysisRate,
                midi: median(stable.map(frame => frame.midi)),
            });
        }
        run = [];
        key = null;
    }

    frames.forEach((frame, index) => {
        const previous = frames[index - 1];
        const next = frames[index + 1];
        const rounded = Math.round(frame.midi);
        // Keep a single excursion during vibrato or a tracking dropout in the same note.
        const isolated = previous && next && next.time - previous.time < 0.04 &&
            Math.round(previous.midi) === Math.round(next.midi);
        const frameKey = isolated ? Math.round(previous.midi) : rounded;
        if (run.length && (frame.time - run.at(-1).time > 0.049 || frameKey !== key)) finish();
        if (!run.length) key = frameKey;
        run.push(frame);
    });
    finish();
    return notes;
}

self.onmessage = ({ data: { id, samples, sampleRate } }) => {
    try {
        const signal = downsample(samples, sampleRate);
        const difference = new Float32Array(maxLag + 1);
        const frames = [];
        for (let center = 0; center + hop <= signal.length; center += hop) {
            const midi = pitchAt(signal, center, difference);
            if (midi !== null) frames.push({ time: center / analysisRate, midi });
        }
        self.postMessage({ id, frames, notes: groupNotes(frames) });
    } catch {
        self.postMessage({ id, error: true });
    }
};
