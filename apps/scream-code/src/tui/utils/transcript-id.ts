let transcriptIdCounter = 0;

export function nextTranscriptId(): string {
  transcriptIdCounter += 1;
  return `entry-${String(transcriptIdCounter)}`;
}
