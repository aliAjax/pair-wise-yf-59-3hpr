import { configureStore, createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit';
import type {
  Boat,
  Penalty,
  Race,
  RaceStatus,
  RecallStatus,
  ResultSnapshot,
  StartStatus,
  TimelineEvent,
  Protest,
  ProtestStatus,
  ResultVersion,
  StartRecord,
  ArrivalRecord
} from './types';
import { raceApi } from './api';

export interface AppState {
  races: Race[];
  boats: Boat[];
  penalties: Penalty[];
  protests: Protest[];
  timeline: TimelineEvent[];
}

const boats: Boat[] = [
  { id: 'boat-1', name: '海风号', sailNo: 'CHN 218', skipper: '林舟' },
  { id: 'boat-2', name: '远岚号', sailNo: 'CHN 106', skipper: '周屿' },
  { id: 'boat-3', name: '北辰号', sailNo: 'CHN 077', skipper: '许澄' }
];

const now = new Date();
const races: Race[] = [
  {
    id: 'race-1',
    name: '海湾长距离赛 第1轮',
    fleet: '统一级',
    course: 'W2 / 东北风 12节',
    startsAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    status: 'scheduled',
    recall: 'none',
    starts: [],
    arrivals: [],
    versions: []
  },
  {
    id: 'race-2',
    name: '海湾长距离赛 第2轮',
    fleet: '统一级',
    course: 'W3 / 东北风 10节',
    startsAt: new Date(now.getTime() + 75 * 60 * 1000).toISOString(),
    status: 'scheduled',
    recall: 'none',
    starts: [],
    arrivals: [],
    versions: []
  }
];

const initialState: AppState = {
  races,
  boats,
  penalties: [],
  protests: [
    {
      id: 'protest-1',
      raceId: 'race-1',
      boatId: 'boat-2',
      reason: '起航后发生舷侧接触',
      rule: 'RRS 14',
      status: 'reviewing',
      decision: '',
      createdAt: now.toISOString()
    }
  ],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布，按场次登记起航' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ]
};

function addTimeline(state: AppState, type: TimelineEvent['type'], message: string) {
  state.timeline.unshift({ id: nanoid(), time: new Date().toISOString(), type, message });
}

function boatName(state: AppState, boatId: string) {
  return state.boats.find((b) => b.id === boatId)?.name ?? boatId;
}

/** 正式成绩发布后冻住：存在 frozen 版本即视为冻结 */
function isFrozen(race: Race) {
  return race.versions.some((v) => v.frozen);
}

/**
 * 按场次重算名次。
 * - 未作废到达按总用时（净用时+处罚秒数）排序
 * - 黑旗处罚（未失效且 appliedToRaceId 命中本场）记 DSQ
 * - 抗议/改判处罚加罚秒数
 */
export function computeRankings(race: Race, penalties: Penalty[]): ResultSnapshot[] {
  const map = new Map<string, ResultSnapshot>();
  for (const a of race.arrivals) {
    if (a.voided) continue;
    map.set(a.boatId, {
      boatId: a.boatId,
      elapsedSeconds: a.elapsedSeconds,
      penaltySeconds: a.penaltySeconds,
      totalSeconds: a.elapsedSeconds + a.penaltySeconds,
      rank: 0,
      status: 'finished'
    });
  }
  for (const p of penalties) {
    if (p.invalid || p.appliedToRaceId !== race.id) continue;
    if (p.type === 'blackFlag') {
      const cur = map.get(p.boatId);
      if (cur) {
        cur.status = 'dsq';
      } else {
        map.set(p.boatId, {
          boatId: p.boatId,
          elapsedSeconds: 0,
          penaltySeconds: 0,
          totalSeconds: Number.POSITIVE_INFINITY,
          rank: 0,
          status: 'dsq'
        });
      }
    } else {
      const add = p.penaltySeconds ?? 0;
      const cur = map.get(p.boatId);
      if (cur) {
        cur.penaltySeconds += add;
        cur.totalSeconds = cur.elapsedSeconds + cur.penaltySeconds;
      } else {
        map.set(p.boatId, {
          boatId: p.boatId,
          elapsedSeconds: 0,
          penaltySeconds: add,
          totalSeconds: add,
          rank: 0,
          status: 'finished'
        });
      }
    }
  }
  const arr = [...map.values()];
  arr.sort((x, y) => {
    if (x.status === 'dsq' && y.status === 'dsq') return 0;
    if (x.status === 'dsq') return 1;
    if (y.status === 'dsq') return -1;
    return x.totalSeconds - y.totalSeconds;
  });
  arr.forEach((r, i) => {
    r.rank = i + 1;
  });
  return arr;
}

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: RaceStatus }>) {
      const race = state.races.find((r) => r.id === action.payload.id);
      if (!race || race.status === action.payload.status) return;
      race.status = action.payload.status;
      addTimeline(state, 'race', `${race.name} 状态更新为 ${action.payload.status}`);
    },

    /**
     * 按场次登记起航。
     * - 事件幂等：同 eventId 不重复处理（断网恢复重放不重复记罚）
     * - 已确认起航锁定：晚到记录不可覆盖已确认起航结果
     * - 两个终端同时提交：按事件顺序合并，先到的确认结果优先
     */
    registerStart(
      state,
      action: PayloadAction<{ raceId: string; boatId: string; status: StartStatus; source: string; eventId?: string }>
    ) {
      const race = state.races.find((r) => r.id === action.payload.raceId);
      if (!race) return;
      if (race.status === 'cancelled') {
        addTimeline(state, 'system', `${race.name} 已取消，起航登记被忽略`);
        return;
      }
      const eventId = action.payload.eventId ?? nanoid();
      if (race.starts.some((s) => s.eventId === eventId)) return; // 幂等去重
      const existing = race.starts.find((s) => s.boatId === action.payload.boatId);
      if (existing) {
        if (existing.confirmed) {
          addTimeline(
            state,
            'system',
            `${boatName(state, action.payload.boatId)} 起航已确认，晚到事件 ${eventId.slice(0, 6)}（终端 ${action.payload.source}）不覆盖`
          );
          return;
        }
        existing.status = action.payload.status;
        existing.confirmed = action.payload.status !== 'pending';
        existing.eventId = eventId;
        existing.source = action.payload.source;
        existing.recordedAt = new Date().toISOString();
      } else {
        const record: StartRecord = {
          id: nanoid(),
          boatId: action.payload.boatId,
          status: action.payload.status,
          confirmed: action.payload.status !== 'pending',
          eventId,
          source: action.payload.source,
          recordedAt: new Date().toISOString()
        };
        race.starts.push(record);
      }
      addTimeline(
        state,
        'race',
        `${race.name} ${boatName(state, action.payload.boatId)} 起航登记为 ${action.payload.status}（终端 ${action.payload.source}）`
      );
    },

    /**
     * 登记到达成绩。
     * - 事件幂等
     * - 一般召回/黑旗召回后，未起航船（status !== 'started'）的到达自动作废
     * - 正式成绩冻结后不再接收到达记录
     */
    registerArrival(
      state,
      action: PayloadAction<{ raceId: string; boatId: string; elapsedSeconds: number; penaltySeconds?: number; source: string; eventId?: string }>
    ) {
      const race = state.races.find((r) => r.id === action.payload.raceId);
      if (!race || race.status === 'cancelled') return;
      if (isFrozen(race)) {
        addTimeline(state, 'system', `${race.name} 正式成绩已冻结，到达记录不再接收，请改判另开新版本`);
        return;
      }
      const eventId = action.payload.eventId ?? nanoid();
      if (race.arrivals.some((a) => a.eventId === eventId)) return; // 幂等去重
      const start = race.starts.find((s) => s.boatId === action.payload.boatId);
      const voided = race.recall !== 'none' && (!start || start.status !== 'started');
      const record: ArrivalRecord = {
        id: nanoid(),
        boatId: action.payload.boatId,
        elapsedSeconds: action.payload.elapsedSeconds,
        penaltySeconds: action.payload.penaltySeconds ?? 0,
        voided,
        voidReason: voided ? `召回作废（${race.recall === 'general' ? '一般召回' : '黑旗召回'}）` : undefined,
        eventId,
        source: action.payload.source,
        recordedAt: new Date().toISOString()
      };
      race.arrivals.push(record);
      addTimeline(
        state,
        'result',
        `${race.name} ${boatName(state, action.payload.boatId)} 到达 ${action.payload.elapsedSeconds}s${voided ? '（召回作废）' : ''}`
      );
    },

    /**
     * 发出召回。
     * - 一般召回：只作废该场未起航船的到达成绩
     * - 黑旗召回：抢航（ocs）船处黑旗处罚，顺延到下一个有效场次
     */
    signalRecall(state, action: PayloadAction<{ raceId: string; type: RecallStatus }>) {
      const race = state.races.find((r) => r.id === action.payload.raceId);
      if (!race || race.status === 'cancelled') return;
      race.recall = action.payload.type;
      race.recalledAt = new Date().toISOString();
      for (const a of race.arrivals) {
        const start = race.starts.find((s) => s.boatId === a.boatId);
        if (!start || start.status !== 'started') {
          a.voided = true;
          a.voidReason = `召回作废（${action.payload.type === 'general' ? '一般召回' : '黑旗召回'}）`;
        }
      }
      if (action.payload.type === 'blackFlag') {
        for (const s of race.starts) {
          if (s.status !== 'ocs') continue;
          const exists = state.penalties.some(
            (p) => p.boatId === s.boatId && p.raceId === race.id && p.type === 'blackFlag' && !p.invalid
          );
          if (exists) continue; // 幂等：同一船同一场不重复记罚
          state.penalties.push({
            id: nanoid(),
            boatId: s.boatId,
            raceId: race.id,
            type: 'blackFlag',
            carryOver: true,
            invalid: false,
            eventId: nanoid(),
            createdAt: new Date().toISOString()
          });
        }
      }
      addTimeline(
        state,
        'race',
        `${race.name} 发出${action.payload.type === 'general' ? '一般召回' : '黑旗召回'}，未起航船到达作废，抢航船黑旗处罚顺延`
      );
    },

    /** 开始比赛：顺延处罚执行到本有效场次 */
    startRace(state, action: PayloadAction<{ raceId: string }>) {
      const race = state.races.find((r) => r.id === action.payload.raceId);
      if (!race || race.status === 'cancelled') return;
      race.status = 'running';
      for (const p of state.penalties) {
        if (p.carryOver && !p.invalid && !p.appliedToRaceId) {
          p.appliedToRaceId = race.id;
          addTimeline(state, 'penalty', `${boatName(state, p.boatId)} 黑旗处罚顺延至 ${race.name} 执行`);
        }
      }
      addTimeline(state, 'race', `${race.name} 开始比赛`);
    },

    finishRace(state, action: PayloadAction<{ raceId: string }>) {
      const race = state.races.find((r) => r.id === action.payload.raceId);
      if (!race || race.status === 'cancelled') return;
      race.status = 'finished';
      addTimeline(state, 'race', `${race.name} 比赛结束，可发布正式成绩`);
    },

    /**
     * 取消场次。
     * - 原发场次取消：该场处罚失效（无依据）
     * - 执行场次取消：顺延处罚释放，继续顺延到下一个有效场次
     */
    cancelRace(state, action: PayloadAction<{ raceId: string; reason?: string }>) {
      const race = state.races.find((r) => r.id === action.payload.raceId);
      if (!race) return;
      race.status = 'cancelled';
      const reason = action.payload.reason ?? '竞赛取消';
      for (const p of state.penalties) {
        if (p.raceId === race.id && !p.invalid) {
          p.invalid = true;
          p.invalidReason = `场次取消：${reason}`;
        } else if (p.appliedToRaceId === race.id && p.raceId !== race.id && !p.invalid) {
          p.appliedToRaceId = undefined;
        }
      }
      addTimeline(state, 'race', `${race.name} 已取消（${reason}），原发处罚失效，顺延处罚继续顺延`);
    },

    /**
     * 发布正式成绩。
     * - 首次发布：第 1 版正式成绩，冻结
     * - 已冻结后再发布：改判另开新版本（version+1），旧版保留
     */
    publishResults(state, action: PayloadAction<{ raceId: string; reason?: string }>) {
      const race = state.races.find((r) => r.id === action.payload.raceId);
      if (!race || race.status === 'cancelled') return;
      const latest = race.versions[race.versions.length - 1];
      const isRevision = !!latest?.frozen;
      const version = isRevision ? latest.version + 1 : (latest?.version ?? 0) + 1;
      const snapshot = computeRankings(race, state.penalties);
      const record: ResultVersion = {
        version,
        status: 'official',
        frozen: true,
        reason: isRevision ? action.payload.reason ?? '裁判改判' : undefined,
        publishedAt: new Date().toISOString(),
        results: snapshot,
        createdAt: new Date().toISOString()
      };
      race.versions.push(record);
      addTimeline(
        state,
        'result',
        `${race.name} 第 ${version} 版正式成绩发布${isRevision ? '（改判新版本）' : ''}，成绩冻结`
      );
    },

    /** 裁判改判：原处罚失效，名次随 selectors 重算 */
    revisePenalty(state, action: PayloadAction<{ penaltyId: string; reason: string }>) {
      const p = state.penalties.find((x) => x.id === action.payload.penaltyId);
      if (!p || p.invalid) return;
      p.invalid = true;
      p.invalidReason = `裁判改判：${action.payload.reason}`;
      addTimeline(state, 'penalty', `${boatName(state, p.boatId)} 处罚改判失效：${action.payload.reason}`);
    },

    addProtest(state, action: PayloadAction<{ raceId: string; boatId: string; reason: string; rule: string }>) {
      const protest: Protest = {
        id: nanoid(),
        ...action.payload,
        status: 'submitted',
        decision: '',
        createdAt: new Date().toISOString()
      };
      state.protests.unshift(protest);
      addTimeline(state, 'protest', `收到 ${action.payload.rule} 抗议，等待复核`);
    },

    transitionProtest(
      state,
      action: PayloadAction<{ id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }>
    ) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;
      if (action.payload.status === 'resolved') {
        protest.penaltySeconds = action.payload.penaltySeconds ?? 0;
        state.penalties.push({
          id: nanoid(),
          boatId: protest.boatId,
          raceId: protest.raceId,
          type: 'protest',
          carryOver: false,
          appliedToRaceId: protest.raceId,
          invalid: false,
          penaltySeconds: action.payload.penaltySeconds ?? 0,
          eventId: nanoid(),
          createdAt: new Date().toISOString()
        });
      }
      addTimeline(state, 'protest', `抗议 ${action.payload.id.slice(0, 6)} 更新为 ${action.payload.status}`);
    }
  }
});

const STORAGE_KEY = 'regatta-control-v2';
const stored = localStorage.getItem(STORAGE_KEY);
const preloadedState = stored ? ({ regatta: JSON.parse(stored) as AppState } as { regatta: AppState }) : undefined;

export const {
  setRaceStatus,
  registerStart,
  registerArrival,
  signalRecall,
  startRace,
  finishRace,
  cancelRace,
  publishResults,
  revisePenalty,
  addProtest,
  transitionProtest
} = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  preloadedState,
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
