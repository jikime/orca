import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { PieChatMember } from '../../../../shared/pie-chat-contract'
import { ComposerToolbar } from './ComposerToolbar'
import { RichChatComposerEditor, type RichChatComposerEditorHandle } from './RichChatComposerEditor'
import { translate } from '@/i18n/i18n'

type MessageComposerProps = {
  disabled: boolean
  sending: boolean
  onSend: (body: string) => void | Promise<void>
}

// Thread replies have no attachments, and mentions are optional; this stays a
// visual sibling of ChannelComposer's container/toolbar shape (STYLEGUIDE
// "sibling components") without inventing left-side controls that do nothing.
const NO_MEMBERS: PieChatMember[] = []

export function MessageComposer({
  disabled,
  sending,
  onSend
}: MessageComposerProps): React.JSX.Element {
  const [empty, setEmpty] = useState(true)
  const [showFormatting, setShowFormatting] = useState(true)
  const editorRef = useRef<RichChatComposerEditorHandle>(null)
  const canSend = !empty && !disabled && !sending

  const submit = (): void => {
    if (!canSend) {
      return
    }
    void onSend(editorRef.current?.getMarkdown() ?? '')
    editorRef.current?.clear()
  }

  return (
    <div className="border-t border-border bg-background p-3">
      <div
        className={cn(
          'flex flex-col rounded-md border border-input bg-background transition-[color,box-shadow]',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50'
        )}
      >
        <RichChatComposerEditor
          ref={editorRef}
          members={NO_MEMBERS}
          disabled={disabled}
          placeholder={translate('auto.pie.chat.MessageComposer.b3da98cf31', 'Write a message…')}
          showFormatting={showFormatting}
          onEmptyChange={setEmpty}
          onEnterSubmit={submit}
        />
        <ComposerToolbar
          canSend={canSend}
          sending={sending}
          onSend={submit}
          formattingVisible={showFormatting}
          onToggleFormatting={() => setShowFormatting((current) => !current)}
        />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {translate(
          'auto.pie.chat.MessageComposer.d0e71fb68e',
          'Enter to send · Shift+Enter for a new line'
        )}
      </p>
    </div>
  )
}
