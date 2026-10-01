import type {
  BlackFlagPenalty,
  Boat,
  Protest,
  PublishEvent,
  Race,
  RaceProjection,
  RaceResult,
  RegattaEvent,
  StartEvent,
  ResultCode,
} from './types';

export interface EventContext {
  events: RegattaEvent[];
  races: Race[];
  boats: Boat[];
}

const decisionRank: Record<StartEvent['decision'], number> = {
  clean: 0,
  individual_recall: 1,
  general_recall: 2,
  black_flag: 3
};

export function eventOrder(a: RegattaEvent, b: RegattaEvent) {
  const occurred = new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
  if (occurred !== 0) return occurred;
  const received = new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime();
  if (received !== 0) return received;
  if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
  return a.id.localeCompare(b.id);
}

export function sortEvents(events: RegattaEvent[]) {
  return [...events].sort(eventOrder);
}

function isCancelled(events: RegattaEvent[], raceId: string) {
  return events.some((event) => event.type === 'race-cancel' && event.raceId === raceId);
}

export function getReversedStartIds(events: RegattaEvent[]) {
  const reversed = new Set<string>();
  for (const event of events) {
    if (event.type === 'start-reversal') reversed.add(event.startEventId);
  }
  return reversed;
}

export function getActiveStarts(events: RegattaEvent[], raceId: string) {
  const reversed = getReversedStartIds(events);
  const cancelled = isCancelled(events, raceId);
  return events
    .filter((event): event is StartEvent => event.type === 'start' && event.raceId === raceId)
    .filter((event) => !cancelled && !reversed.has(event.id))
    .sort(eventOrder);
}

function sameBoatSet(a: string[], b: string[]) {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((boatId, index) => boatId === right[index]);
}

export function isDuplicateStart(existing: StartEvent, candidate: StartEvent) {
  return existing.raceId === candidate.raceId
    && existing.attempt === candidate.attempt
    && existing.decision === candidate.decision
    && sameBoatSet(existing.boatIds, candidate.boatIds);
}

export function decisionLabel(decision: StartEvent['decision']) {
  const labels: Record<StartEvent['decision'], string> = {
    clean: '正常起航',
    individual_recall: '个别召回',
    black_flag: '黑旗',
    general_recall: '一般召回'
  };
  return labels[decision];
}

function getLatestPublish(events: RegattaEvent[], raceId: string) {
  return [...events]
    .filter((event): event is PublishEvent => event.type === 'publish' && event.raceId === raceId)
    .sort(eventOrder)
    .at(-1);
}

export function resultSignature(results: RaceResult[]) {
  return JSON.stringify(results
    .map((result) => [result.boatId, result.attempt ?? '', result.code, result.elapsedSeconds ?? '', [...result.appliedPenaltyIds].sort().join('|')])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

export function computeResults(events: RegattaEvent[], race: Race, boats: Boat[], penalties: BlackFlagPenalty[]): RaceResult[] {
  if (isCancelled(events, race.id)) return [];
  const starts = getActiveStarts(events, race.id);
  if (starts.length === 0) return [];

  const results = new Map<string, RaceResult>();
  for (const boat of boats) {
    const eligibleStarts = starts.filter((start) => {
      if (start.decision === 'clean') return true;
      if (start.decision === 'general_recall') return !start.boatIds.some((recall) =>
        recall === boat.id || starts.some((other) => other.attempt === start.attempt && other.decision === 'black_flag' && other.boatIds.includes(recall))
      );
      return !start.boatIds.includes(boat.id);
    });
    const latestEligible = eligibleStarts.at(-1);

    const lastGeneralRecall = [...starts].reverse().find((start) => start.decision === 'general_recall');
    const recalledBeforeRestart = Boolean(lastGeneralRecall
      && lastGeneralRecall.boatIds.length > 0
      && lastGeneralRecall.boatIds.includes(boat.id)
      && (!latestEligible || eventOrder(latestEligible, lastGeneralRecall) < 0));
    if (recalledBeforeRestart && lastGeneralRecall) {
      results.set(boat.id, { raceId: race.id, boatId: boat.id, attempt: lastGeneralRecall.attempt, code: 'DNC', elapsedSeconds: null, appliedPenaltyIds: [] });
      continue;
    }
    const timeEvent = [...events]
      .filter((event) =>
        (event.type === 'arrival' || event.type === 'correction')
        && event.raceId === race.id
        && event.boatId === boat.id
        && latestEligible !== undefined
        && event.attempt === latestEligible.attempt
      )
      .sort(eventOrder)
      .at(-1);

    const appliedPenalties = penalties.filter((penalty) =>
      penalty.status === 'applied' && penalty.targetRaceId === race.id && penalty.boatId === boat.id
    );
    if (appliedPenalties.length > 0) {
      results.set(boat.id, {
        raceId: race.id,
        boatId: boat.id,
        attempt: latestEligible?.attempt ?? null,
        code: 'BFD',
        elapsedSeconds: null,
        appliedPenaltyIds: appliedPenalties.map((penalty) => penalty.id)
      });
      continue;
    }

    const voidedBlackStartIds = new Set(penalties
      .filter((penalty) => penalty.status === 'voided' && penalty.voidReason === '裁判改判')
      .map((penalty) => penalty.sourceEventId));
    const blackStart = [...starts].reverse().find((start) =>
      start.decision === 'black_flag'
      && start.boatIds.includes(boat.id)
      && !voidedBlackStartIds.has(start.id)
    );
    if (blackStart) {
      results.set(boat.id, { raceId: race.id, boatId: boat.id, attempt: blackStart.attempt, code: 'BFD', elapsedSeconds: null, appliedPenaltyIds: [] });
      continue;
    }

    const recalledStart = [...starts].reverse().find((start) => start.decision === 'individual_recall' && start.boatIds.includes(boat.id));
    if (recalledStart && !latestEligible) {
      results.set(boat.id, { raceId: race.id, boatId: boat.id, attempt: recalledStart.attempt, code: 'OCS', elapsedSeconds: null, appliedPenaltyIds: [] });
      continue;
    }

    if (latestEligible && timeEvent && (timeEvent.type === 'arrival' || timeEvent.type === 'correction')) {
      results.set(boat.id, {
        raceId: race.id,
        boatId: boat.id,
        attempt: latestEligible.attempt,
        code: 'FIN',
        elapsedSeconds: timeEvent.elapsedSeconds,
        appliedPenaltyIds: []
      });
    } else if (latestEligible) {
      results.set(boat.id, { raceId: race.id, boatId: boat.id, attempt: latestEligible.attempt, code: 'DNF', elapsedSeconds: null, appliedPenaltyIds: [] });
    } else {
      results.set(boat.id, { raceId: race.id, boatId: boat.id, attempt: null, code: 'DNC', elapsedSeconds: null, appliedPenaltyIds: [] });
    }
  }

  return rankResults([...results.values()]);
}

const codeOrder: Record<ResultCode, number> = { FIN: 0, BFD: 1, OCS: 2, DSQ: 3, DNF: 4, DNC: 5 };

export function rankResults(results: RaceResult[]) {
  return [...results].sort((a, b) => {
    const rank = codeOrder[a.code] - codeOrder[b.code];
    if (rank !== 0) return rank;
    if (a.elapsedSeconds !== null && b.elapsedSeconds !== null) return a.elapsedSeconds - b.elapsedSeconds;
    return a.boatId.localeCompare(b.boatId);
  });
}

export function projectRace(context: EventContext, race: Race): RaceProjection {
  const { events, boats } = context;
  const penalties = getPenalties(events);
  const cancelled = isCancelled(events, race.id);
  const starts = getActiveStarts(events, race.id);
  const latestStart = starts.at(-1);
  const computed = computeResults(events, race, boats, penalties);
  const latestPublish = getLatestPublish(events, race.id);
  const frozen = latestPublish ? resultSignature(latestPublish.results as RaceResult[]) === resultSignature(computed) : false;
  const hasDraftChanges = Boolean(latestPublish && !frozen);
  const currentVersion = latestPublish ? (frozen ? latestPublish.version : latestPublish.version + 1) : 1;

  return {
    race,
    state: cancelled
      ? 'cancelled'
      : latestStart?.decision === 'general_recall' && latestStart.boatIds.length === 0
        ? 'recalled'
        : starts.length > 0
          ? 'active'
          : 'scheduled',
    currentVersion,
    publishedVersion: latestPublish?.version ?? null,
    isFrozen: frozen,
    hasDraftChanges,
    starts: sortEvents(events).filter((event): event is StartEvent => event.type === 'start' && event.raceId === race.id).map((event) => ({
      event,
      active: starts.some((start) => start.id === event.id),
      reversed: getReversedStartIds(events).has(event.id),
      boatIds: event.boatIds
    })),
    results: latestPublish && frozen ? rankResults(latestPublish.results as RaceResult[]) : computed,
    penalties: penalties.filter((penalty) => penalty.originRaceId === race.id || penalty.targetRaceId === race.id)
  };
}

function getVoidedPenaltyIds(events: RegattaEvent[]) {
  const reversals = new Set<string>();
  for (const event of events) if (event.type === 'judge-reversal') reversals.add(event.penaltyId);
  return reversals;
}

export function getPenalties(events: RegattaEvent[]): BlackFlagPenalty[] {
  const ordered = sortEvents(events);
  const reversedStarts = getReversedStartIds(events);
  const judgeReversals = getVoidedPenaltyIds(events);
  const blackStarts = ordered.filter((event): event is StartEvent =>
    event.type === 'start'
    && event.decision === 'black_flag'
    && !reversedStarts.has(event.id)
  );

  return blackStarts.flatMap((start) => start.boatIds.map((boatId): BlackFlagPenalty => {
    const penaltyId = start.penaltyId ?? `${start.id}:${boatId}`;
    if (judgeReversals.has(penaltyId)) {
      return { id: penaltyId, sourceEventId: start.id, originRaceId: start.raceId, boatId, status: 'voided', voidReason: '裁判改判' };
    }

    if (isCancelled(ordered, start.raceId)) {
      return { id: penaltyId, sourceEventId: start.id, originRaceId: start.raceId, boatId, status: 'voided', voidReason: '原场次取消' };
    }

    const target = findPenaltyTarget(ordered, start);
    if (!target || isCancelled(ordered, target.raceId)) {
      return { id: penaltyId, sourceEventId: start.id, originRaceId: start.raceId, boatId, status: 'pending' };
    }
    return {
      id: penaltyId,
      sourceEventId: start.id,
      originRaceId: start.raceId,
      boatId,
      status: 'applied',
      targetRaceId: target.raceId
    };
  }));
}

function findPenaltyTarget(events: RegattaEvent[], source: StartEvent) {
  const reversedStarts = getReversedStartIds(events);
  const latestStartByRace = new Map<string, StartEvent>();
  for (const start of events.filter((event): event is StartEvent => event.type === 'start' && !reversedStarts.has(event.id))) {
    const existing = latestStartByRace.get(start.raceId);
    if (!existing || eventOrder(start, existing) > 0) latestStartByRace.set(start.raceId, start);
  }

  return [...latestStartByRace.values()]
    .filter((start) => start.raceId !== source.raceId)
    .filter((start) => !isCancelled(events, start.raceId))
    .filter((start) => eventOrder(start, source) > 0)
    .filter((start) => !(start.decision === 'general_recall' && start.boatIds.length === 0))
    .sort(eventOrder)
    .at(0);
}

export function validateEvent(context: EventContext, event: RegattaEvent): { accepted: boolean; reason?: string } {
  const { events, races, boats } = context;
  if (events.some((item) => item.id === event.id)) {
    return { accepted: false, reason: '同一事件已处理，已按幂等规则忽略' };
  }

  if (event.type === 'start') {
    if (isCancelled(events, event.raceId)) return { accepted: false, reason: '场次已取消，不能再登记起航' };
    const confirmed = getActiveStarts(events, event.raceId).find((item) => item.attempt === event.attempt);
    if (confirmed) {
      const complementaryGeneralRecall = event.decision === 'general_recall'
        && confirmed.decision === 'black_flag'
        && event.boatIds.every((boatId) => !confirmed.boatIds.includes(boatId));
      if (complementaryGeneralRecall) {
        // A recalled fleet can be recorded alongside the black-flagged boats; rankings are projected from both.
      } else if (isDuplicateStart(confirmed, event)) {
        return { accepted: false, reason: '晚到的重复起航记录已合并，未覆盖已确认结果' };
      } else {
        return { accepted: false, reason: `第 ${event.attempt} 航次已有确认起航（${decisionLabel(confirmed.decision)}），晚到记录不能覆盖` };
      }
    }
  }

  if (event.type === 'arrival' || event.type === 'correction') {
    const race = races.find((item) => item.id === event.raceId);
    if (!race) return { accepted: false, reason: '未知场次' };
    if (isCancelled(events, event.raceId)) return { accepted: false, reason: '场次已取消，到达成绩不再生效' };
    const latestPublish = getLatestPublish(events, event.raceId);
    if (latestPublish) {
      const projection = projectRace(context, race);
      if (projection.isFrozen && event.type === 'arrival') {
        return { accepted: false, reason: '正式成绩已冻结；普通到达不能覆盖，请提交改判新版本' };
      }
    }
    if (event.type === 'correction') {
      if (!event.reason.trim()) return { accepted: false, reason: '改判必须填写原因' };
      if (!latestPublish) return { accepted: false, reason: '正式成绩发布前请直接登记到达，不需要另开版本' };
    }
  }

  if (event.type === 'race-cancel') {
    if (isCancelled(events, event.raceId)) return { accepted: false, reason: '该场次已经取消' };
  }

  if (event.type === 'start-reversal') {
    const target = events.find((item) => item.id === event.startEventId);
    if (!target || target.type !== 'start' || target.raceId !== event.raceId || target.attempt !== event.attempt) {
      return { accepted: false, reason: '未找到要撤销的起航记录' };
    }
    if (getReversedStartIds(events).has(target.id)) return { accepted: false, reason: '该起航已经被改判' };
  }

  if (event.type === 'judge-reversal') {
    const penalty = getPenalties(events).find((item) => item.id === event.penaltyId);
    if (!penalty) return { accepted: false, reason: '未找到黑旗处罚' };
    if (penalty.status === 'voided') return { accepted: false, reason: '处罚已经失效，不能重复撤销' };
  }

  if (event.type === 'publish') {
    if (isCancelled(events, event.raceId)) return { accepted: false, reason: '取消场次不能发布正式成绩' };
    const race = races.find((item) => item.id === event.raceId);
    if (!race) return { accepted: false, reason: '未知场次' };
    const starts = getActiveStarts(events, event.raceId);
    const latest = starts.at(-1);
    if (!latest) return { accepted: false, reason: '该场次尚未确认起航' };
    if (latest.decision === 'general_recall' && latest.boatIds.length === 0) return { accepted: false, reason: '一般召回后需重新起航，暂不能发布正式成绩' };
    const projection = projectRace(context, race);
    if (projection.isFrozen) return { accepted: false, reason: '正式成绩已冻结，没有需要发布的改判' };
  }

  if (event.type === 'protest' && boats.length > 0 && !boats.some((boat) => boat.id === event.boatId)) {
    return { accepted: false, reason: '未知参赛船' };
  }

  return { accepted: true };
}

export function getProtests(events: RegattaEvent[]): Protest[] {
  const byId = new Map<string, Protest>();
  for (const event of sortEvents(events)) {
    if (event.type !== 'protest') continue;
    byId.set(event.protestId, {
      id: event.protestId,
      raceId: event.raceId,
      boatId: event.boatId,
      rule: event.rule,
      reason: event.reason,
      status: event.status,
      decision: event.decision,
      createdAt: event.occurredAt
    });
  }
  return [...byId.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function nextAttempt(events: RegattaEvent[], raceId: string) {
  const attempts = events.filter((event): event is StartEvent => event.type === 'start' && event.raceId === raceId).map((event) => event.attempt);
  return Math.max(0, ...attempts) + 1;
}
