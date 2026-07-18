import { ChatMarkdown } from './ChatMarkdown'

// Renders an untrusted chat message body as sanitized Markdown. Formatting,
// mention/#channel highlighting, and the safe sanitize schema all live in
// ChatMarkdown; this stays a thin wrapper so the { body } prop/export is stable.
export function MessageBody({ body }: { body: string }): React.JSX.Element {
  return <ChatMarkdown body={body} />
}
