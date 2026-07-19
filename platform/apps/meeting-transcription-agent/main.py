import asyncio
import logging
import os

from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    AutoSubscribe,
    JobContext,
    JobProcess,
    StopResponse,
    cli,
    llm,
    room_io,
    utils,
)
from livekit.plugins import openai, silero

logger = logging.getLogger("pie-meeting-transcriber")


class ParticipantTranscriber(Agent):
    def __init__(self, participant_identity: str) -> None:
        super().__init__(
            instructions="Transcribe the participant exactly without answering.",
            stt=openai.STT(model=os.getenv("PIE_LIVE_CAPTION_MODEL", "gpt-4o-mini-transcribe")),
        )
        self.participant_identity = participant_identity

    async def on_user_turn_completed(
        self, chat_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        logger.info("%s -> %s", self.participant_identity, new_message.text_content)
        # This is a caption-only agent; stopping the response prevents accidental LLM output.
        raise StopResponse()


class MultiParticipantTranscriber:
    def __init__(self, ctx: JobContext) -> None:
        self.ctx = ctx
        self.sessions: dict[str, AgentSession] = {}
        self.tasks: set[asyncio.Task] = set()

    def start(self) -> None:
        self.ctx.room.on("participant_connected", self.on_participant_connected)
        self.ctx.room.on("participant_disconnected", self.on_participant_disconnected)

    async def close(self) -> None:
        await utils.aio.cancel_and_wait(*self.tasks)
        await asyncio.gather(*(self.close_session(session) for session in self.sessions.values()))
        self.ctx.room.off("participant_connected", self.on_participant_connected)
        self.ctx.room.off("participant_disconnected", self.on_participant_disconnected)

    def on_participant_connected(self, participant: rtc.RemoteParticipant) -> None:
        if participant.identity in self.sessions:
            return
        task = asyncio.create_task(self.start_session(participant))
        self.tasks.add(task)

        def on_done(completed: asyncio.Task) -> None:
            try:
                self.sessions[participant.identity] = completed.result()
            finally:
                self.tasks.discard(completed)

        task.add_done_callback(on_done)

    def on_participant_disconnected(self, participant: rtc.RemoteParticipant) -> None:
        session = self.sessions.pop(participant.identity, None)
        if session is None:
            return
        task = asyncio.create_task(self.close_session(session))
        self.tasks.add(task)
        task.add_done_callback(lambda completed: self.tasks.discard(completed))

    async def start_session(self, participant: rtc.RemoteParticipant) -> AgentSession:
        existing = self.sessions.get(participant.identity)
        if existing:
            return existing
        session = AgentSession(vad=self.ctx.proc.userdata["vad"])
        await session.start(
            agent=ParticipantTranscriber(participant.identity),
            room=self.ctx.room,
            room_options=room_io.RoomOptions(
                audio_input=True,
                text_output=True,
                audio_output=False,
                participant_identity=participant.identity,
                text_input=False,
            ),
        )
        return session

    async def close_session(self, session: AgentSession) -> None:
        await session.drain()
        await session.aclose()


# A local meeting stack needs one warm worker; the production default of twelve
# wastes memory and temporary sockets before any room requests transcription.
server = AgentServer(num_idle_processes=1)


def prewarm(process: JobProcess) -> None:
    process.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session(agent_name="pie-transcriber")
async def entrypoint(ctx: JobContext) -> None:
    transcriber = MultiParticipantTranscriber(ctx)
    transcriber.start()
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    for participant in ctx.room.remote_participants.values():
        transcriber.on_participant_connected(participant)
    ctx.add_shutdown_callback(transcriber.close)


if __name__ == "__main__":
    cli.run_app(server)
