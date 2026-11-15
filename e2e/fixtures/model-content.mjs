/** OpenAI user content becomes multimodal when a visible PDF page is shared. */
export function modelText(message) {
  return typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
}
