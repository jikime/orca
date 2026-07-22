import { useCallback, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import type {
  PieChatMember,
  PieChatRendererApi,
  PieMessage
} from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'
import { chatMemberDisplayName } from './chat-member-display-name'

type MessageSearchProps = {
  api: PieChatRendererApi
  members: PieChatMember[]
  // Selecting a result hands the message back so the workspace can focus its
  // channel and refetch to bring it into view.
  onSelect: (message: PieMessage) => void
}

export function MessageSearch({ api, members, onSelect }: MessageSearchProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PieMessage[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  const run = useCallback(async (): Promise<void> => {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      return
    }
    setSearching(true)
    try {
      const response = await api.searchMessages(trimmed)
      setResults(response.items)
      setSearched(true)
    } finally {
      setSearching(false)
    }
  }, [api, query])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={translate('auto.pie.chat.MessageSearch.80369f911c', 'Search messages')}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {translate('auto.pie.chat.MessageSearch.2cd24b7430', '🔍 Search')}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.pie.chat.MessageSearch.80369f911c', 'Search messages')}
          </DialogTitle>
        </DialogHeader>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void run()
            }
          }}
          placeholder={translate('auto.pie.chat.MessageSearch.23c294cdb6', 'Search all channels…')}
          aria-label={translate('auto.pie.chat.MessageSearch.74c0712232', 'Search query')}
          autoFocus
        />
        <ScrollArea className="max-h-80">
          <div className="flex flex-col gap-1">
            {searching ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                {translate('auto.pie.chat.MessageSearch.23b1e37fa3', 'Searching…')}
              </p>
            ) : searched && results.length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                {translate('auto.pie.chat.MessageSearch.4f46932269', 'No matches')}
              </p>
            ) : (
              results.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  onClick={() => {
                    onSelect(message)
                    setOpen(false)
                  }}
                  className="rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <div className="text-xs text-muted-foreground">
                    {chatMemberDisplayName(message.authorId, members)}
                  </div>
                  <div className="truncate text-sm text-foreground">{message.body}</div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
