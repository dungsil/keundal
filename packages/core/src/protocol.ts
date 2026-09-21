import { EventType as UpstreamEventType } from '@ag-ui/core'
import {
  EventSchemas as UpstreamEventSchemas,
  RunAgentInputSchema as UpstreamRunAgentInputSchema
} from '@ag-ui/core/schemas'
import type {
  AGUIEvent as UpstreamAGUIEvent,
  BaseEvent as UpstreamBaseEvent,
  Context as UpstreamContext,
  Message as UpstreamMessage,
  ResumeEntry as UpstreamResumeEntry,
  Role as UpstreamRole,
  RunAgentInput as UpstreamRunAgentInput,
  RunErrorEvent as UpstreamRunErrorEvent,
  RunFinishedEvent as UpstreamRunFinishedEvent,
  RunStartedEvent as UpstreamRunStartedEvent,
  Tool as UpstreamTool
} from '@ag-ui/core'

export const EventType = UpstreamEventType
export type EventType = UpstreamEventType

export type AgentRole = UpstreamRole
export type AgentMessage = UpstreamMessage
export type AgentTool = UpstreamTool
export type AgentContextEntry = UpstreamContext
export type ResumeEntry = UpstreamResumeEntry
export type RunAgentInput = UpstreamRunAgentInput

export type BaseEvent = UpstreamBaseEvent
export type AGUIEvent = UpstreamAGUIEvent
export type RunStartedEvent = UpstreamRunStartedEvent
export type RunFinishedEvent = UpstreamRunFinishedEvent
export type RunErrorEvent = UpstreamRunErrorEvent

export function parseRunAgentInput(value: unknown): RunAgentInput {
  return UpstreamRunAgentInputSchema.parse(value) as RunAgentInput
}

export function parseAGUIEvent(value: unknown): AGUIEvent {
  return UpstreamEventSchemas.parse(value) as AGUIEvent
}
