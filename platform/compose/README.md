# Local meeting media

LiveKit is the WebRTC media plane for Pie meetings. Cameras and microphones connect directly to
LiveKit; the control-plane API keeps invitations, presence, recording consent, and minutes. The
profile also starts LiveKit Egress, SeaweedFS object storage, and the consent-gated caption agent.

1. Copy `.env.meeting.example` to an untracked `.env.meeting` file and replace both credentials.
2. Export the same values for the control-plane API:

   ```sh
   export PIE_LIVEKIT_WS_URL=ws://127.0.0.1:7880
   export PIE_LIVEKIT_API_KEY='<same key>'
   export PIE_LIVEKIT_API_SECRET='<same secret>'
   export PIE_OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:8333
   export PIE_OBJECT_STORAGE_BUCKET=pie-artifacts
   export PIE_OBJECT_STORAGE_ACCESS_KEY=pie
   export PIE_OBJECT_STORAGE_SECRET_KEY=pie-secret
   # This endpoint is interpreted by the Egress container, not by the host API.
   export PIE_LIVEKIT_EGRESS_S3_ENDPOINT=http://meeting-storage:8333
   export PIE_MEETING_TRANSCRIPTION_AGENT_NAME=pie-transcriber
   export OPENAI_API_KEY='<same OpenAI key as .env.meeting>'
   ```

   If port `8333` is already in use, set `PIE_MEETING_STORAGE_PORT` in `.env.meeting` and use the
   same port in `PIE_OBJECT_STORAGE_ENDPOINT`; the container-to-container Egress endpoint remains
   `http://meeting-storage:8333`.

3. Start the media profile:

   ```sh
   docker compose --env-file platform/compose/.env.meeting \
     -f platform/compose/meeting.compose.yaml --profile meeting up -d
   ```

4. Run database migrations, then start the control-plane API and worker normally. The worker uses
   `PIE_OBJECT_STORAGE_*` and `OPENAI_API_KEY` to produce a diarized transcript and an AI minutes
   draft after Egress closes. `GET /.well-known/pie` then advertises
   `videoMeeting: true` and the local media endpoint.

Recording always requires unanimous consent from currently connected participants. Starting a
recording launches MP4 and compact MP3 Egress outputs plus live captions; stopping it queues the MP3
for post-recording transcription. AI minutes remain a draft until a member with
`meeting.minutes.review` approves them.

Room recording runs two media pipelines (MP4 playback and MP3 transcription audio), so leave ample
Docker VM memory and disk capacity. If Egress reports `signal: bus error`, or SeaweedFS becomes
read-only below its free-space threshold, inspect `docker system df` and Docker Desktop resource
limits. Expand or clean that environment before retrying; do not lower SeaweedFS's safety threshold
for persistent meeting data.

The compose file is a loopback development setup. A remote or SSH deployment must use a publicly
reachable `wss://` URL, trusted TLS, and the production LiveKit network topology; the desktop client
never assumes that the media server is on the same machine as the Electron process.
