export type RaceStatus = 'scheduled' | 'running' | 'finished' | 'cancelled';
export type StartStatus = 'pending' | 'started' | 'ocs' | 'dns';
export type RecallStatus = 'none' | 'general' | 'blackFlag';
export type ResultStatus = 'provisional' | 'official';
export type PenaltyType = 'blackFlag' | 'protest' | 'redress';

export interface Boat {
  id: string;
  name: string;
  sailNo: string;
  skipper: string;
}

/** 起航登记：按场次登记，confirmed 后锁定，晚到事件不可覆盖 */
export interface StartRecord {
  id: string;
  boatId: string;
  status: StartStatus;
  confirmed: boolean;
  eventId: string;
  source: string;
  recordedAt: string;
}

/** 到达成绩：一般召回只作废未起航船的到达 */
export interface ArrivalRecord {
  id: string;
  boatId: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  voided: boolean;
  voidReason?: string;
  eventId: string;
  source: string;
  recordedAt: string;
}

/** 处罚：黑旗顺延到下一个有效场次；取消/改判会让原处罚失效 */
export interface Penalty {
  id: string;
  boatId: string;
  raceId: string;
  type: PenaltyType;
  carryOver: boolean;
  appliedToRaceId?: string;
  invalid: boolean;
  invalidReason?: string;
  penaltySeconds?: number;
  eventId: string;
  createdAt: string;
}

export interface ResultSnapshot {
  boatId: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  totalSeconds: number;
  rank: number;
  status: 'finished' | 'dsq' | 'dns' | 'ocs';
}

/** 成绩版本：正式发布后冻住，改判另开新版本 */
export interface ResultVersion {
  version: number;
  status: ResultStatus;
  frozen: boolean;
  reason?: string;
  publishedAt?: string;
  results: ResultSnapshot[];
  createdAt: string;
}

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
  recall: RecallStatus;
  recalledAt?: string;
  starts: StartRecord[];
  arrivals: ArrivalRecord[];
  versions: ResultVersion[];
}

export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';

export interface Protest {
  id: string;
  raceId: string;
  boatId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  penaltySeconds?: number;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'system' | 'penalty';
  message: string;
}
