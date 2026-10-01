import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { raceApi } from './api';
import { projectRace, validateEvent } from './domain';
import type { Boat, PendingOutboxEvent, Race, RaceResult, RegattaEvent } from './types';

export interface AppState {
  races: Race[];
  boats: Boat[];
  events: RegattaEvent[];
  outbox: PendingOutboxEvent[];
  terminalId: string;
  online: boolean;
}

const base = Date.parse('2026-10-01T09:00:00.000Z');
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();

const boats: Boat[] = [
  { id: 'boat-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟' },
  { id: 'boat-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿' },
  { id: 'boat-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄' },
  { id: 'boat-4', boat: '白鸥号', sailNo: 'CHN 139', skipper: '沈砚' }
];

const races: Race[] = [
  { id: 'race-1', name: '海湾长距离赛 · 第1场', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: at(0), order: 1, status: 'scheduled' },
  { id: 'race-2', name: '海湾长距离赛 · 第2场', fleet: '统一级', course: 'W2 / 南风 10节', startsAt: at(3600), order: 2, status: 'scheduled' },
  { id: 'race-3', name: '海湾长距离赛 · 第3场', fleet: '统一级', course: 'W3 / 东南风 14节', startsAt: at(7200), order: 3, status: 'scheduled' }
];

const initialEvents: RegattaEvent[] = [
  {
    id: 'event-seed-start-1',
    seq: 1,
    type: 'start',
    raceId: 'race-1',
    attempt: 1,
    decision: 'black_flag',
    boatIds: ['boat-3'],
    penaltyId: 'penalty-seed-1',
    occurredAt: at(0),
    receivedAt: at(1),
    terminalId: 'terminal-A'
  },
  {
    id: 'event-seed-arrival-1',
    seq: 2,
    type: 'arrival',
    raceId: 'race-1',
    attempt: 1,
    boatId: 'boat-1',
    elapsedSeconds: 3168,
    occurredAt: at(3168),
    receivedAt: at(3171),
    terminalId: 'terminal-B'
  },
  {
    id: 'event-seed-arrival-2',
    seq: 3,
    type: 'arrival',
    raceId: 'race-1',
    attempt: 1,
    boatId: 'boat-2',
    elapsedSeconds: 3194,
    occurredAt: at(3194),
    receivedAt: at(3196),
    terminalId: 'terminal-B'
  },
  {
    id: 'event-seed-arrival-4',
    seq: 4,
    type: 'arrival',
    raceId: 'race-1',
    attempt: 1,
    boatId: 'boat-4',
    elapsedSeconds: 3218,
    note: '一般召回演练船：未重新起航时该到达应作废',
    occurredAt: at(3218),
    receivedAt: at(3220),
    terminalId: 'terminal-B'
  },
  {
    id: 'event-seed-protest',
    seq: 5,
    type: 'protest',
    protestId: 'protest-seed-1',
    raceId: 'race-1',
    boatId: 'boat-2',
    rule: 'RRS 14',
    reason: '起航后发生舷侧接触',
    status: 'reviewing',
    decision: '',
    occurredAt: at(3300),
    receivedAt: at(3301),
    terminalId: 'terminal-A'
  }
];

export const initialState: AppState = {
  races,
  boats,
  events: initialEvents,
  outbox: [],
  terminalId: 'terminal-A',
  online: true
};

const STORAGE_KEY = 'regatta-control-v2';
function loadStoredState(): AppState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return initialState;
  try {
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (!Array.isArray(parsed.races) || !Array.isArray(parsed.boats) || !Array.isArray(parsed.events)) return initialState;
    return {
      races: parsed.races,
      boats: parsed.boats,
      events: parsed.events,
      outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
      terminalId: parsed.terminalId ?? initialState.terminalId,
      online: parsed.online ?? true
    };
  } catch {
    return initialState;
  }
}

const preloadedState = loadStoredState();

interface IngestResult {
  accepted: boolean;
  reason?: string;
}

function appendEvent(state: AppState, event: RegattaEvent): IngestResult {
  const decision = validateEvent(state, event);
  if (!decision.accepted) {
    if (event.type !== 'system') {
      state.events.push({
        id: crypto.randomUUID(),
        seq: state.events.reduce((max, item) => Math.max(max, item.seq ?? 0), 0) + 1,
        type: 'system',
        kind: 'conflict',
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        terminalId: state.terminalId,
        message: decision.reason ?? '事件被拒绝',
        rejectedEventId: event.id
      });
    }
    return decision;
  }

  const nextSeq = state.events.reduce((max, item) => Math.max(max, item.seq ?? 0), 0) + 1;
  state.events.push({ ...event, seq: nextSeq });
  return { accepted: true };
}

const slice = createSlice({
  name: 'regatta',
  initialState: preloadedState,
  reducers: {
    setTerminal(state, action: PayloadAction<string>) {
      state.terminalId = action.payload;
    },
    setConnection(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
    },
    receiveEvent(state, action: PayloadAction<RegattaEvent>) {
      appendEvent(state, action.payload);
    },
    submitEvent(state, action: PayloadAction<RegattaEvent>) {
      if (!state.online) {
        if (!state.outbox.some((item) => item.event.id === action.payload.id)) {
          state.outbox.push({ id: crypto.randomUUID(), queuedAt: new Date().toISOString(), event: action.payload });
        }
        return;
      }
      appendEvent(state, action.payload);
    },
    flushOutbox(state) {
      if (!state.online) return;
      const queued = [...state.outbox].sort((a, b) =>
        new Date(a.event.occurredAt).getTime() - new Date(b.event.occurredAt).getTime()
        || a.queuedAt.localeCompare(b.queuedAt)
      );
      state.outbox = [];
      for (const item of queued) {
        appendEvent(state, { ...item.event, receivedAt: new Date().toISOString() });
      }
    },
    cancelRace(state, action: PayloadAction<{ raceId: string; reason: string }>) {
      const event: RegattaEvent = {
        id: crypto.randomUUID(),
        type: 'race-cancel',
        raceId: action.payload.raceId,
        reason: action.payload.reason,
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        terminalId: state.terminalId
      };
      appendEvent(state, event);
    },
    reverseStart(state, action: PayloadAction<{ raceId: string; startEventId: string; reason: string }>) {
      const start = state.events.find((event) => event.id === action.payload.startEventId && event.type === 'start');
      if (!start || start.type !== 'start') return;
      const event: RegattaEvent = {
        id: crypto.randomUUID(),
        type: 'start-reversal',
        raceId: action.payload.raceId,
        attempt: start.attempt,
        startEventId: start.id,
        reason: action.payload.reason,
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        terminalId: state.terminalId
      };
      appendEvent(state, event);
    },
    reversePenalty(state, action: PayloadAction<{ penaltyId: string; reason: string }>) {
      const event: RegattaEvent = {
        id: crypto.randomUUID(),
        type: 'judge-reversal',
        penaltyId: action.payload.penaltyId,
        reason: action.payload.reason,
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        terminalId: state.terminalId
      };
      appendEvent(state, event);
    },
    publishRace(state, action: PayloadAction<{ raceId: string }>) {
      const race = state.races.find((item) => item.id === action.payload.raceId);
      if (!race) return;
      const projection = projectRace(state, race);
      const event: RegattaEvent = {
        id: crypto.randomUUID(),
        type: 'publish',
        raceId: race.id,
        version: projection.currentVersion,
        results: projection.results.map((result): RaceResult => result),
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        terminalId: state.terminalId
      };
      appendEvent(state, event);
    },
    resetDemo() {
      return initialState;
    }
  }
});

export const {
  setTerminal,
  setConnection,
  receiveEvent,
  submitEvent,
  flushOutbox,
  cancelRace,
  reverseStart,
  reversePenalty,
  publishRace,
  resetDemo
} = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
