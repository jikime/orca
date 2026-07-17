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
import type { PieChatRendererApi, PieMessage } from '../../../../shared/pie-chat-contract'

type MessageSearchProps = {
  api: PieChatRendererApi
  // Selecting a result hands the message back so the workspace can focus its
  // channel and refetch to bring it into view.
  onSelect: (message: PieMessage) => void
}

export function MessageSearch({ api, onSelect }: MessageSearchProps): React.JSX.Element {
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
          aria-label="Search messages"
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          🔍 Search
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Search messages</DialogTitle>
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
          placeholder="Search all channels…"
          aria-label="Search query"
          autoFocus
        />
        <ScrollArea className="max-h-80">
          <div className="flex flex-col gap-1">
            {searching ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">Searching…</p>
            ) : searched && results.length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">No matches</p>
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
                    {message.authorId.slice(0, 8)}
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
