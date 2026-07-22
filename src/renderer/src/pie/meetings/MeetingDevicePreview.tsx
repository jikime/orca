import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  CameraOff,
  LoaderCircle,
  Mic,
  MicOff,
  PhoneCall,
  RefreshCw,
  Volume2,
  Wifi,
  WifiOff
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { MeetingMediaDiagnostics } from './meeting-types'

export type MeetingDevicePreferences = {
  cameraEnabled: boolean
  microphoneEnabled: boolean
  cameraDeviceId: string
  microphoneDeviceId: string
  speakerDeviceId: string
}

type DeviceLists = {
  cameras: MediaDeviceInfo[]
  microphones: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
}

const EMPTY_DEVICES: DeviceLists = { cameras: [], microphones: [], speakers: [] }

function deviceLabel(device: MediaDeviceInfo, index: number, fallback: string): string {
  return device.label.trim() || `${fallback} ${index + 1}`
}

function firstDevice(devices: MediaDeviceInfo[], current: string): string {
  return devices.some((device) => device.deviceId === current)
    ? current
    : (devices.find((device) => device.deviceId === 'default')?.deviceId ??
        devices[0]?.deviceId ??
        '')
}

export function MeetingDevicePreview({
  joining,
  waiting,
  connectionError,
  diagnostics,
  diagnosticsLoading,
  diagnosticsError,
  onRetryDiagnostics,
  onJoin
}: {
  joining: boolean
  waiting: boolean
  connectionError: string | null
  diagnostics: MeetingMediaDiagnostics | null
  diagnosticsLoading: boolean
  diagnosticsError: string | null
  onRetryDiagnostics: () => void
  onJoin: (preferences: MeetingDevicePreferences) => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [devices, setDevices] = useState<DeviceLists>(EMPTY_DEVICES)
  const [cameraDeviceId, setCameraDeviceId] = useState('')
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState('')
  const [speakerDeviceId, setSpeakerDeviceId] = useState('')
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const refreshDevices = useCallback(async (): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return
    }
    const available = await navigator.mediaDevices.enumerateDevices()
    const next = {
      cameras: available.filter((device) => device.kind === 'videoinput'),
      microphones: available.filter((device) => device.kind === 'audioinput'),
      speakers: available.filter((device) => device.kind === 'audiooutput')
    }
    setDevices(next)
    setCameraDeviceId((current) => firstDevice(next.cameras, current))
    setMicrophoneDeviceId((current) => firstDevice(next.microphones, current))
    setSpeakerDeviceId((current) => firstDevice(next.speakers, current))
  }, [])

  useEffect(() => {
    void refreshDevices().catch(() => undefined)
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices?.addEventListener) {
      return
    }
    const changed = (): void => void refreshDevices()
    mediaDevices.addEventListener('devicechange', changed)
    return () => mediaDevices.removeEventListener('devicechange', changed)
  }, [refreshDevices])

  useEffect(() => {
    let cancelled = false
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (!cameraEnabled && !microphoneEnabled) {
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setPreviewError('Media devices are unavailable in this environment.')
      return
    }
    void navigator.mediaDevices
      .getUserMedia({
        video: cameraEnabled
          ? { deviceId: cameraDeviceId ? { exact: cameraDeviceId } : undefined }
          : false,
        audio: microphoneEnabled
          ? { deviceId: microphoneDeviceId ? { exact: microphoneDeviceId } : undefined }
          : false
      })
      .then(async (stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => undefined)
        }
        setPreviewError(null)
        await refreshDevices()
      })
      .catch((caught) => {
        if (!cancelled) {
          setPreviewError(caught instanceof Error ? caught.message : String(caught))
          setCameraEnabled(false)
          setMicrophoneEnabled(false)
        }
      })
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [cameraDeviceId, cameraEnabled, microphoneDeviceId, microphoneEnabled, refreshDevices])

  const join = (): void => {
    onJoin({
      cameraEnabled,
      microphoneEnabled,
      cameraDeviceId,
      microphoneDeviceId,
      speakerDeviceId
    })
  }

  return (
    <div className="grid min-h-72 gap-4 rounded-lg border border-border bg-card p-4 md:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="relative flex min-h-56 items-center justify-center overflow-hidden rounded-md bg-muted">
        <video ref={videoRef} muted playsInline className="size-full object-cover" />
        {!cameraEnabled && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <CameraOff className="size-6" />
            <span className="text-xs">
              {translate('auto.pie.meetings.prejoin.cameraOff', 'Camera is off')}
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {translate('auto.pie.meetings.prejoin.title', 'Check your devices')}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'auto.pie.meetings.prejoin.body',
              'Choose devices and preview them before joining.'
            )}
          </p>
        </div>
        <div className="rounded-md border border-border bg-muted/40 p-2.5 text-xs">
          <div className="flex items-center gap-2">
            {diagnosticsLoading ? (
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            ) : diagnostics?.status === 'unavailable' || diagnosticsError ? (
              <WifiOff className="size-3.5 text-destructive" />
            ) : (
              <Wifi className="size-3.5 text-muted-foreground" />
            )}
            <span className="font-medium text-foreground">
              {translate('auto.pie.meetings.prejoin.connectionCheck', 'Connection check')}
            </span>
            {diagnostics && (
              <Badge variant="outline" className="ml-auto">
                {diagnostics.status}
              </Badge>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={diagnosticsLoading || joining}
              aria-label={translate('auto.pie.meetings.prejoin.retryCheck', 'Run check again')}
              onClick={onRetryDiagnostics}
            >
              <RefreshCw />
            </Button>
          </div>
          <p className="mt-1 text-muted-foreground">
            {diagnosticsLoading
              ? translate('auto.pie.meetings.prejoin.checking', 'Checking LiveKit endpoint…')
              : diagnosticsError
                ? diagnosticsError
                : diagnostics?.latencyMs === null
                  ? translate('auto.pie.meetings.prejoin.mediaUnavailable', 'Media is unavailable.')
                  : translate(
                      'auto.pie.meetings.prejoin.mediaLatency',
                      'Control plane ready · media {{value0}} ms',
                      { value0: diagnostics?.latencyMs ?? '—' }
                    )}
          </p>
        </div>
        <Select
          value={cameraDeviceId || undefined}
          onValueChange={setCameraDeviceId}
          disabled={joining || devices.cameras.length === 0}
        >
          <SelectTrigger
            className="w-full"
            aria-label={translate('auto.pie.meetings.prejoin.chooseCamera', 'Choose camera')}
          >
            <SelectValue placeholder={translate('auto.pie.meetings.prejoin.camera', 'Camera')} />
          </SelectTrigger>
          <SelectContent>
            {devices.cameras.map((device, index) => (
              <SelectItem key={device.deviceId} value={device.deviceId}>
                {deviceLabel(
                  device,
                  index,
                  translate('auto.pie.meetings.prejoin.camera', 'Camera')
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={microphoneDeviceId || undefined}
          onValueChange={setMicrophoneDeviceId}
          disabled={joining || devices.microphones.length === 0}
        >
          <SelectTrigger
            className="w-full"
            aria-label={translate(
              'auto.pie.meetings.prejoin.chooseMicrophone',
              'Choose microphone'
            )}
          >
            <SelectValue
              placeholder={translate('auto.pie.meetings.prejoin.microphone', 'Microphone')}
            />
          </SelectTrigger>
          <SelectContent>
            {devices.microphones.map((device, index) => (
              <SelectItem key={device.deviceId} value={device.deviceId}>
                {deviceLabel(
                  device,
                  index,
                  translate('auto.pie.meetings.prejoin.microphone', 'Microphone')
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={speakerDeviceId || undefined}
          onValueChange={setSpeakerDeviceId}
          disabled={joining || devices.speakers.length === 0}
        >
          <SelectTrigger
            className="w-full"
            aria-label={translate('auto.pie.meetings.prejoin.chooseSpeaker', 'Choose speaker')}
          >
            <Volume2 />
            <SelectValue placeholder={translate('auto.pie.meetings.prejoin.speaker', 'Speaker')} />
          </SelectTrigger>
          <SelectContent>
            {devices.speakers.map((device, index) => (
              <SelectItem key={device.deviceId} value={device.deviceId}>
                {deviceLabel(
                  device,
                  index,
                  translate('auto.pie.meetings.prejoin.speaker', 'Speaker')
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={microphoneEnabled ? 'secondary' : 'outline'}
            disabled={joining}
            onClick={() => setMicrophoneEnabled((value) => !value)}
          >
            {microphoneEnabled ? <Mic /> : <MicOff />}
            {translate('auto.pie.meetings.prejoin.microphone', 'Microphone')}
          </Button>
          <Button
            size="sm"
            variant={cameraEnabled ? 'secondary' : 'outline'}
            disabled={joining}
            onClick={() => setCameraEnabled((value) => !value)}
          >
            {cameraEnabled ? <Camera /> : <CameraOff />}
            {translate('auto.pie.meetings.prejoin.camera', 'Camera')}
          </Button>
        </div>
        <Button
          className="mt-auto"
          size="sm"
          disabled={joining || waiting || diagnostics?.status === 'unavailable'}
          onClick={join}
        >
          <PhoneCall />
          {waiting
            ? translate('auto.pie.meetings.prejoin.waiting', 'Waiting for host approval…')
            : joining
              ? translate('auto.pie.meetings.prejoin.joining', 'Joining…')
              : translate('auto.pie.meetings.prejoin.join', 'Join meeting')}
        </Button>
        {(previewError || connectionError) && (
          <p className="text-xs text-destructive">{previewError ?? connectionError}</p>
        )}
      </div>
    </div>
  )
}
