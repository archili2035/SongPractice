class PracticeRecorder extends AudioWorkletProcessor {
    constructor({ processorOptions }) {
        super();
        this.firstFrame = processorOptions.firstFrame;
        this.lastFrame = this.firstFrame + 600 * sampleRate;
        this.block = new Float32Array(8192);
        this.count = 0;
        this.finished = false;
        this.port.onmessage = () => this.finish();
    }

    flush() {
        if (!this.count) return;
        this.port.postMessage(this.block.subarray(0, this.count), [this.block.buffer]);
        this.block = new Float32Array(8192);
        this.count = 0;
    }

    finish() {
        if (this.finished) return;
        this.flush();
        this.port.postMessage('done');
        this.finished = true;
    }

    process(inputs, outputs) {
        if (this.finished) return false;
        const input = inputs[0]?.[0];
        // The output remains silent so the recording does not feed back into the microphone.
        const length = outputs[0][0].length;
        const start = Math.max(0, this.firstFrame - currentFrame);
        const end = Math.min(length, this.lastFrame - currentFrame);
        for (let i = start; i < end; i++) {
            this.block[this.count++] = input?.[i] ?? 0;
            if (this.count === this.block.length) this.flush();
        }
        if (currentFrame + length >= this.lastFrame) this.finish();
        return !this.finished;
    }
}

registerProcessor('practice-recorder', PracticeRecorder);
