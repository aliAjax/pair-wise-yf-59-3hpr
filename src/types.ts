export type StartDecision = 'clean' | 'individual_recall' | 'general_recall' | 'black_flag';
export type RaceLifecycleStatus = 'scheduled' | 'cancelled';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultCode = 'FIN' | 'BFD' | 'OCS' | 'DNF' | 'DSQ' | 'DNC';
export type PenaltyStatus = 'pending' | 'applied' | 'voided';

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  order: number;
  status: RaceLifecycleStatus;
}

export interface Boat {
  id: string;
  boat: string;
  sailNo: string;
  skipper: string;
}

export interface RegattaEventBase {
  id: string;
  seq?: number;
  occurredAt: string;
  receivedAt: string;
  terminalId: string;
}

export interface StartEvent extends RegattaEventBase {
  type: 'start';
  raceId: string;
  attempt: number;
  decision: StartDecision;
  boatIds: string[];
  penaltyId?: string;
}

export interface ArrivalEvent extends RegattaEventBase {
  type: 'arrival';
  raceId: string;
  attempt: number;
  boatId: string;
  elapsedSeconds: number;
  note?: string;
}

export interface RaceCancelEvent extends RegattaEventBase {
  type: 'race-cancel';
  raceId: string;
  reason: string;
}

export interface StartReversalEvent extends RegattaEventBase {
  type: 'start-reversal';
  raceId: string;
  attempt: number;
  startEventId: string;
  reason: string;
}

export interface JudgeReversalEvent extends RegattaEventBase {
  type: 'judge-reversal';
  penaltyId: string;
  reason: string;
}

export interface PublishedResult {
  boatId: string;
  code: ResultCode;
  elapsedSeconds: number | null;
  appliedPenaltyIds: string[];
}

export interface PublishEvent extends RegattaEventBase {
  type: 'publish';
  raceId: string;
  version: number;
  results: PublishedResult[];
}

export interface CorrectionEvent extends RegattaEventBase {
  type: 'correction';
  raceId: string;
  boatId: string;
  attempt: number;
  elapsedSeconds: number;
  reason: string;
}

export interface ProtestEvent extends RegattaEventBase {
  type: 'protest';
  protestId: string;
  raceId: string;
  boatId: string;
  rule: string;
  reason: string;
  status: ProtestStatus;
  decision: string;
}

export interface SystemEvent extends RegattaEventBase {
  type: 'system';
  kind: 'conflict' | 'sync' | 'penalty';
  message: string;
  rejectedEventId?: string;
}

export type RegattaEvent =
  | StartEvent
  | ArrivalEvent
  | RaceCancelEvent
  | StartReversalEvent
  | JudgeReversalEvent
  | PublishEvent
  | CorrectionEvent
  | ProtestEvent
  | SystemEvent;

export interface PendingOutboxEvent {
  id: string;
  queuedAt: string;
  event: RegattaEvent;
}

export interface Protest {
  id: string;
  raceId: string;
  boatId: string;
  rule: string;
  reason: string;
  status: ProtestStatus;
  decision: string;
  createdAt: string;
}

export interface BlackFlagPenalty {
  id: string;
  sourceEventId: string;
  originRaceId: string;
  boatId: string;
  status: PenaltyStatus;
  targetRaceId?: string;
  voidReason?: string;
}

export interface RaceResult {
  raceId: string;
  boatId: string;
  attempt: number | null;
  code: ResultCode;
  elapsedSeconds: number | null;
  appliedPenaltyIds: string[];
}

export interface RaceProjection {
  race: Race;
  state: 'scheduled' | 'recalled' | 'active' | 'cancelled';
  currentVersion: number;
  publishedVersion: number | null;
  isFrozen: boolean;
  hasDraftChanges: boolean;
  starts: Array<{
    event: StartEvent;
    active: boolean;
    reversed: boolean;
    boatIds: string[];
  }>;
  results: RaceResult[];
  penalties: BlackFlagPenalty[];
}
