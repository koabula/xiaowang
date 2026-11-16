/** A short descending two-note cue, separate from microphone and model playback. */
export async function playHangupSound(): Promise<void> {
  const context = new AudioContext();
  try {
    await context.resume();
    const start = context.currentTime + 0.01;
    for (const [offset, frequency] of [[0, 660], [0.105, 440]] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start + offset);
      gain.gain.linearRampToValueAtTime(0.1, start + offset + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.08);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.09);
      if (offset) oscillator.onended = () => { void context.close().catch(() => {}); };
    }
  } catch {
    await context.close().catch(() => {});
  }
}
