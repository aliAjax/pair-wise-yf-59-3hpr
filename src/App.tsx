import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Menu,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { ClockCircleOutlined, CloudServerOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { decisionLabel, getActiveStarts, getProtests, nextAttempt, projectRace } from './domain';
import {
  cancelRace,
  flushOutbox,
  publishRace,
  receiveEvent,
  resetDemo,
  reversePenalty,
  reverseStart,
  setConnection,
  setTerminal,
  submitEvent,
  type AppDispatch,
  type RootState,
} from './store';
import { useGetOfficialsQuery } from './api';
import type { Boat, RaceProjection, RegattaEvent, ResultCode, StartDecision } from './types';

const { Header, Content, Sider } = Layout;

const protestSchema = z.object({
  boatId: z.string().min(1),
  rule: z.string().min(2),
  reason: z.string().min(4),
});

const codeLabel: Record<ResultCode, { text: string; color: string }> = {
  FIN: { text: '完成', color: 'green' },
  BFD: { text: '黑旗取消资格', color: 'red' },
  OCS: { text: '抢航', color: 'orange' },
  DNF: { text: '未完赛', color: 'gold' },
  DSQ: { text: '取消资格', color: 'red' },
  DNC: { text: '未参赛', color: 'default' },
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function makeEventBase(terminalId: string, occurredAt: string) {
  return {
    id: crypto.randomUUID(),
    occurredAt,
    receivedAt: new Date().toISOString(),
    terminalId,
  };
}

function useRegattaData(raceId: string) {
  const races = useSelector((state: RootState) => state.regatta.races);
  const boats = useSelector((state: RootState) => state.regatta.boats);
  const events = useSelector((state: RootState) => state.regatta.events);
  const race = races.find((item) => item.id === raceId) ?? races[0];
  const projection = useMemo(() => projectRace({ events, races, boats }, race), [events, races, boats, race]);
  return { races, boats, events, race, projection };
}

function RaceSwitch({ raceId, onChange }: { raceId: string; onChange: (id: string) => void }) {
  const races = useSelector((state: RootState) => state.regatta.races);
  const events = useSelector((state: RootState) => state.regatta.events);
  return <Segmented
    value={raceId}
    onChange={(value) => onChange(String(value))}
    options={races.map((race) => {
      const cancelled = events.some((event) => event.type === 'race-cancel' && event.raceId === race.id);
      return { label: `${race.order}场 ${cancelled ? '· 取消' : ''}`, value: race.id };
    })}
  />;
}

function TerminalBar() {
  const dispatch = useDispatch<AppDispatch>();
  const terminalId = useSelector((state: RootState) => state.regatta.terminalId);
  const online = useSelector((state: RootState) => state.regatta.online);
  const outbox = useSelector((state: RootState) => state.regatta.outbox);
  const { data = [] } = useGetOfficialsQuery();

  return (
    <Card size="small" style={{ marginBottom: 16 }}>
      <Row gutter={[16, 12]} align="middle">
        <Col>
          <Space>
            <CloudServerOutlined />
            <b>当前终端</b>
            <Select value={terminalId} style={{ width: 150 }} onChange={(value) => dispatch(setTerminal(value))} options={[
              { value: 'terminal-A', label: '终端 A · 竞赛官' },
              { value: 'terminal-B', label: '终端 B · 计时员' },
            ]} />
          </Space>
        </Col>
        <Col>
          <Space>
            <Badge status={online ? 'success' : 'error'} text={online ? '在线' : '断网'} />
            <Switch checked={online} checkedChildren="联网" unCheckedChildren="离线" onChange={(checked) => dispatch(setConnection(checked))} />
            <Button size="small" disabled={online || outbox.length === 0} onClick={() => dispatch(flushOutbox())}>恢复并重放 {outbox.length} 条</Button>
          </Space>
        </Col>
        <Col><Tag>{data.length} 名值班人员</Tag></Col>
        <Col flex="auto" style={{ textAlign: 'right' }}><Button size="small" onClick={() => dispatch(resetDemo())}>重置演示数据</Button></Col>
      </Row>
      {!online && <Alert style={{ marginTop: 12 }} type="warning" message={`断网中：事件保留在本场本终端，恢复后按发生时间合并（${outbox.length} 条待同步）`} />}
    </Card>
  );
}

function RankTable({ projection, boats, showActions = false }: { projection: RaceProjection; boats: Boat[]; showActions?: boolean }) {
  const dispatch = useDispatch<AppDispatch>();
  const boatMap = new Map(boats.map((boat) => [boat.id, boat]));
  return <Table rowKey="boatId" size="small" pagination={false} dataSource={projection.results} columns={[
    { title: '名次', width: 64, render: (_v, _r, index) => projection.race.status === 'scheduled' && !projection.results.some((result) => result.code === 'FIN') ? '—' : index + 1 },
    { title: '船名 / 帆号', render: (_v, r) => {
      const boat = boatMap.get(r.boatId);
      return `${boat?.boat ?? r.boatId} / ${boat?.sailNo ?? ''}`;
    } },
    { title: '航次', dataIndex: 'attempt', render: (attempt: number | null) => attempt ? `第 ${attempt} 航次` : '—' },
    { title: '用时', render: (_v, r) => r.elapsedSeconds === null ? '—' : `${r.elapsedSeconds}s` },
    { title: '状态', render: (_v, r) => <Tag color={codeLabel[r.code].color}>{codeLabel[r.code].text}</Tag> },
    ...(showActions ? [{
      title: '操作',
      render: (_v: unknown, r: { boatId: string; appliedPenaltyIds: string[] }) => r.appliedPenaltyIds[0]
        ? <Button size="small" danger type="link" onClick={() => dispatch(reversePenalty({ penaltyId: r.appliedPenaltyIds[0], reason: '仲裁撤销黑旗处罚' }))}>裁判改判撤销处罚</Button>
        : null,
    }] : [])
  ]} />;
}

function StartForm({ race, projection }: { race: RaceProjection['race']; projection: RaceProjection }) {
  const dispatch = useDispatch<AppDispatch>();
  const { message } = AntApp.useApp();
  const terminalId = useSelector((state: RootState) => state.regatta.terminalId);
  const allEvents = useSelector((state: RootState) => state.regatta.events);
  const boats = useSelector((state: RootState) => state.regatta.boats);
  const [decision, setDecision] = useState<StartDecision>('clean');
  const [boatIds, setBoatIds] = useState<string[]>([]);
  const attempt = nextAttempt(allEvents, race.id);

  const submit = (mode: 'normal' | 'late' | 'conflict') => {
    if ((decision === 'individual_recall' || decision === 'black_flag') && boatIds.length === 0) {
      message.error('个别召回和黑旗必须指定涉及船只');
      return;
    }
    if (decision === 'general_recall' && boatIds.length === 0 && mode !== 'normal') {
      message.error('模拟一般召回时请选择未起航船；留空只用于全场召回后重赛');
      return;
    }
    const occurredAt = mode === 'late'
      ? new Date(Date.now() - 45_000).toISOString()
      : new Date().toISOString();
    const useAttempt = mode === 'conflict' ? Math.max(1, attempt - 1) : attempt;
    const event = {
      ...makeEventBase(terminalId, occurredAt),
      type: 'start' as const,
      raceId: race.id,
      attempt: useAttempt,
      decision,
      boatIds,
      ...(decision === 'black_flag' ? { penaltyId: `penalty-${crypto.randomUUID()}-${boatIds.join('-')}` } : {}),
    };
    const currentAttempt = getActiveStarts(allEvents, race.id).some((item) => item.attempt === useAttempt);
    if (mode !== 'conflict' && currentAttempt) {
      message.warning(`第 ${useAttempt} 航次已有确认起航，晚到记录不能覆盖`);
      return;
    }
    if (mode === 'conflict') {
      const competing = {
        ...makeEventBase(terminalId === 'terminal-A' ? 'terminal-B' : 'terminal-A', new Date(new Date(occurredAt).getTime() - 1).toISOString()),
        type: 'start' as const,
        raceId: race.id,
        attempt: useAttempt,
        decision: 'clean' as const,
        boatIds: [],
      };
      dispatch(receiveEvent(competing));
      dispatch(submitEvent(event));
      message.info(`两个终端同时提交第 ${useAttempt} 航次，已先确认正常起航，后到记录进入冲突时间线`);
    } else {
      dispatch(submitEvent(event));
      message.success(mode === 'late' ? '晚到事件已按发生时间插入，未覆盖已确认起航' : '起航已登记');
    }
    setBoatIds([]);
  };

  return <Card title="按场次 / 航次登记起航" size="small">
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <div><Tag color="blue">下一航次：第 {attempt} 航次</Tag>{projection.starts.at(-1)?.event.decision === 'general_recall' && <Tag color="orange">一般召回：只作废未起航船到达</Tag>}</div>
      <Form layout="vertical">
        <Form.Item label="起航判定">
          <Select value={decision} onChange={(value) => { setDecision(value); setBoatIds([]); }} options={[
            { value: 'clean', label: '正常起航' },
            { value: 'individual_recall', label: '个别召回（抢航船）' },
            { value: 'general_recall', label: '一般召回' },
            { value: 'black_flag', label: '黑旗处罚' },
          ]} />
        </Form.Item>
        <Form.Item label={decision === 'general_recall' ? '未起航船（其到达成绩作废，可留空）' : '涉及船只（正常起航留空）'}>
          <Select mode="multiple" allowClear value={boatIds} onChange={setBoatIds} placeholder="选择抢航/黑旗船只"
            options={boats.map((boat) => ({ value: boat.id, label: `${boat.boat} / ${boat.sailNo}` }))}
            disabled={decision === 'clean'} />
        </Form.Item>
        <Space wrap>
          <Button type="primary" icon={<FlagOutlined />} onClick={() => submit('normal')}>提交起航</Button>
          <Button onClick={() => submit('late')}>模拟晚到记录</Button>
          <Button danger onClick={() => submit('conflict')}>模拟两终端同场冲突</Button>
        </Space>
      </Form>
    </Space>
  </Card>;
}

function StartHistory({ race, projection }: { race: RaceProjection['race']; projection: RaceProjection }) {
  const dispatch = useDispatch<AppDispatch>();
  return <Card title="起航事件与合并结果" size="small" style={{ marginTop: 16 }}>
    {projection.starts.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未登记起航" /> : <List size="small" dataSource={[...projection.starts].reverse()} renderItem={(item) => (
      <List.Item actions={item.active ? [
        <Button key="reverse" size="small" type="link" onClick={() => dispatch(reverseStart({ raceId: race.id, startEventId: item.event.id, reason: '裁判改判撤销起航判定' }))}>裁判改判</Button>
      ] : []}>
        <List.Item.Meta
          title={<Space wrap>
            <b>第 {item.event.attempt} 航次</b>
            <Tag color={item.event.decision === 'clean' ? 'green' : item.event.decision === 'black_flag' ? 'red' : 'orange'}>{decisionLabel(item.event.decision)}</Tag>
            {!item.active && <Tag>已撤销</Tag>}
          </Space>}
          description={`${item.boatIds.length > 0 ? item.boatIds.join('、') : '全船队'} · ${item.event.terminalId} · ${formatTime(item.event.occurredAt)}`}
        />
      </List.Item>
    )} />}
  </Card>;
}

function ControlPage() {
  const [raceId, setRaceId] = useState('race-1');
  const { races, boats, race, projection } = useRegattaData(raceId);
  const dispatch = useDispatch<AppDispatch>();
  const activePenalties = projection.penalties.filter((penalty) => penalty.status !== 'voided');

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <TerminalBar />
      <Space wrap><RaceSwitch raceId={race.id} onChange={setRaceId} /><Tag color={projection.state === 'cancelled' ? 'default' : projection.state === 'active' ? 'green' : 'orange'}>{projection.state}</Tag></Space>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={9}>
          <Card className="hero-card" size="small">
            <Statistic title={race.name} value={`第 ${race.order} 场`} prefix={<FlagOutlined />} />
            <p>{race.fleet} · {race.course}</p>
            <p>计划起航：{formatTime(race.startsAt)}</p>
            <Space wrap>
              <Button disabled={projection.state === 'cancelled'} danger onClick={() => dispatch(cancelRace({ raceId: race.id, reason: '裁判取消本场' }))}>取消本场</Button>
            </Space>
          </Card>
          <div style={{ height: 16 }} />
          <StartForm race={race} projection={projection} />
          <StartHistory race={race} projection={projection} />
        </Col>
        <Col xs={24} xl={15}>
          <Card title="实时名次（按当前事件重算）" size="small" extra={<Space>
            <Tag color={projection.isFrozen ? 'green' : projection.hasDraftChanges ? 'orange' : 'default'}>
              {projection.isFrozen ? `正式版 v${projection.publishedVersion} 已冻结` : projection.hasDraftChanges ? `v${projection.publishedVersion} 冻结，改判草稿 v${projection.currentVersion}` : '临时成绩 v1'}
            </Tag>
          </Space>}>
            {projection.state === 'cancelled' ? <Alert type="info" message="本场已取消；本场黑旗失效，顺延中的处罚自动跳到后续有效场次并重算名次。" /> : <RankTable projection={projection} boats={boats} />}
          </Card>
          <Card title="黑旗处罚流转" size="small" style={{ marginTop: 16 }}>
            {activePenalties.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无有效黑旗处罚" /> : <List size="small" dataSource={activePenalties} renderItem={(penalty) => {
              const boat = boats.find((item) => item.id === penalty.boatId);
              const origin = races.find((item) => item.id === penalty.originRaceId)?.order;
              const target = races.find((item) => item.id === penalty.targetRaceId)?.order;
              return <List.Item><Tag color={penalty.status === 'applied' ? 'red' : 'processing'}>{penalty.status === 'applied' ? `已顺延到第 ${target} 场` : '等待下一个有效场次'}</Tag>
                {boat?.boat} 黑旗来自第 {origin} 场</List.Item>;
            }} />}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function ResultsPage() {
  const [raceId, setRaceId] = useState('race-1');
  const { boats, events, race, projection } = useRegattaData(raceId);
  const dispatch = useDispatch<AppDispatch>();
  const terminalId = useSelector((state: RootState) => state.regatta.terminalId);
  const latestAttempt = nextAttempt(events, race.id) - 1 || 1;
  const [arrival, setArrival] = useState({ boatId: boats[0]?.id ?? '', attempt: latestAttempt, elapsedSeconds: 3200, note: '' });
  const [correction, setCorrection] = useState({ boatId: boats[0]?.id ?? '', attempt: latestAttempt, elapsedSeconds: 3200, reason: '' });

  useEffect(() => {
    const attempt = nextAttempt(events, race.id) - 1 || 1;
    setArrival((value) => ({ ...value, attempt }));
    setCorrection((value) => ({ ...value, attempt }));
  }, [events, race.id]);

  const sendArrival = () => {
    if (!arrival.boatId || arrival.attempt < 1 || arrival.elapsedSeconds <= 0) return;
    dispatch(submitEvent({ ...makeEventBase(terminalId, new Date().toISOString()), type: 'arrival', raceId: race.id, ...arrival }));
    setArrival({ ...arrival, elapsedSeconds: 3200, note: '' });
  };
  const sendCorrection = () => {
    if (!correction.boatId || correction.attempt < 1 || correction.elapsedSeconds <= 0 || correction.reason.trim().length < 4) return;
    dispatch(submitEvent({ ...makeEventBase(terminalId, new Date().toISOString()), type: 'correction', raceId: race.id, ...correction }));
    setCorrection({ ...correction, elapsedSeconds: 3200, reason: '' });
  };

  return <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <TerminalBar />
    <RaceSwitch raceId={race.id} onChange={setRaceId} />
    <Alert type={projection.isFrozen ? 'success' : projection.hasDraftChanges ? 'warning' : 'info'}
      message={projection.isFrozen ? `正式成绩 v${projection.publishedVersion} 已冻结；改判会创建 v${projection.currentVersion + 1}` : projection.hasDraftChanges ? `改判草稿 v${projection.currentVersion} 已形成，确认后发布新版本` : '当前为临时成绩，发布后冻结'} />
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card title="登记到达" size="small">
          <Form layout="vertical" onFinish={sendArrival}>
            <Form.Item label="参赛船"><select className="native-select" value={arrival.boatId} onChange={(event) => setArrival({ ...arrival, boatId: event.target.value })}>{boats.map((boat) => <option key={boat.id} value={boat.id}>{boat.boat}</option>)}</select></Form.Item>
            <Form.Item label="航次"><InputNumber min={1} style={{ width: '100%' }} value={arrival.attempt} onChange={(value) => setArrival({ ...arrival, attempt: Number(value) || 1 })} /></Form.Item>
            <Form.Item label="净用时（秒）"><InputNumber min={1} style={{ width: '100%' }} value={arrival.elapsedSeconds} onChange={(value) => setArrival({ ...arrival, elapsedSeconds: Number(value) || 0 })} /></Form.Item>
            <Form.Item label="备注"><Input.TextArea rows={2} value={arrival.note} onChange={(event) => setArrival({ ...arrival, note: event.target.value })} /></Form.Item>
            <Button htmlType="submit" type="primary">保存到达</Button>
          </Form>
        </Card>
        <Card title="正式成绩冻结后改判" size="small" style={{ marginTop: 16 }}>
          <Form layout="vertical" onFinish={sendCorrection}>
            <Form.Item label="参赛船"><select className="native-select" value={correction.boatId} onChange={(event) => setCorrection({ ...correction, boatId: event.target.value })}>{boats.map((boat) => <option key={boat.id} value={boat.id}>{boat.boat}</option>)}</select></Form.Item>
            <Form.Item label="航次"><InputNumber min={1} style={{ width: '100%' }} value={correction.attempt} onChange={(value) => setCorrection({ ...correction, attempt: Number(value) || 1 })} /></Form.Item>
            <Form.Item label="更正后净用时（秒）"><InputNumber min={1} style={{ width: '100%' }} value={correction.elapsedSeconds} onChange={(value) => setCorrection({ ...correction, elapsedSeconds: Number(value) || 0 })} /></Form.Item>
            <Form.Item label="改判原因"><Input.TextArea rows={3} value={correction.reason} onChange={(event) => setCorrection({ ...correction, reason: event.target.value })} /></Form.Item>
            <Button htmlType="submit" disabled={!projection.isFrozen}>另开改判版本</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card title="名次与发布" size="small" extra={<Button type="primary" disabled={projection.state === 'cancelled' || projection.state === 'scheduled' || projection.state === 'recalled' || projection.isFrozen} onClick={() => dispatch(publishRace({ raceId: race.id }))}>{projection.publishedVersion ? '发布改判新版本' : '发布正式成绩'}</Button>}>
          <RankTable projection={projection} boats={boats} showActions />
        </Card>
      </Col>
    </Row>
  </Space>;
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const races = useSelector((state: RootState) => state.regatta.races);
  const boats = useSelector((state: RootState) => state.regatta.boats);
  const events = useSelector((state: RootState) => state.regatta.events);
  const terminalId = useSelector((state: RootState) => state.regatta.terminalId);
  const [raceId, setRaceId] = useState('race-1');
  const protests = getProtests(events);
  const timeline = [...events].filter((event) => !['arrival', 'correction'].includes(event.type)).sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  const { register, handleSubmit, reset } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { boatId: boats[0]?.id, rule: 'RRS 14', reason: '' } });

  const transition = (id: string, status: 'reviewing' | 'resolved' | 'rejected', decision: string) => {
    const protest = protests.find((item) => item.id === id);
    if (!protest) return;
    dispatch(submitEvent({
      ...makeEventBase(terminalId, new Date().toISOString()),
      type: 'protest',
      protestId: id,
      raceId: protest.raceId,
      boatId: protest.boatId,
      rule: protest.rule,
      reason: protest.reason,
      status,
      decision,
    }));
  };

  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(submitEvent({
      ...makeEventBase(terminalId, new Date().toISOString()),
      type: 'protest',
      protestId: crypto.randomUUID(),
      raceId,
      ...values,
      status: 'submitted',
      decision: '',
    }));
    reset({ boatId: boats[0]?.id, rule: 'RRS 14', reason: '' });
  };

  return <Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <TerminalBar />
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card title="提交抗议 / 申诉" size="small">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="场次"><Select value={raceId} onChange={setRaceId} options={races.map((race) => ({ value: race.id, label: race.name }))} /></Form.Item>
            <Form.Item label="参赛船"><select className="native-select" {...register('boatId')}>{boats.map((boat) => <option key={boat.id} value={boat.id}>{boat.boat} / {boat.sailNo}</option>)}</select></Form.Item>
            <Form.Item label="规则"><Input {...register('rule')} /></Form.Item>
            <Form.Item label="事件描述"><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card title="冲突与仲裁队列" size="small">
          {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => {
            const boat = boats.find((boat) => boat.id === item.boatId);
            const race = races.find((race) => race.id === item.raceId);
            return <List.Item>
              <List.Item.Meta title={<Space><Tag>{item.status}</Tag><b>{item.rule}</b><span>{boat?.boat}</span></Space>}
                description={<><div>{item.reason}</div><small>{race?.name}{item.decision ? ` · ${item.decision}` : ''}</small></>} />
              <Space direction="vertical">
                <Button size="small" onClick={() => transition(item.id, 'reviewing', '进入复核')}>进入复核</Button>
                <Button size="small" type="primary" onClick={() => transition(item.id, 'resolved', '支持抗议，撤销相关起航/处罚并重算')}>支持改判</Button>
                <Button size="small" danger onClick={() => transition(item.id, 'rejected', '证据不足，维持冻结成绩')}>驳回</Button>
              </Space>
            </List.Item>;
          }} />}
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card title="事件时间线（只追加）" size="small">
          <Timeline items={timeline.slice(0, 24).map((event) => ({ color: event.type === 'system' ? 'red' : event.type === 'protest' ? 'orange' : 'blue', children: <TimelineItem event={event} boats={boats} races={races} /> }))} />
        </Card>
      </Col>
    </Row>
  </Space>;
}

function TimelineItem({ event, boats, races }: { event: RegattaEvent; boats: Boat[]; races: RaceProjection['race'][] }) {
  const boat = (id: string) => boats.find((item) => item.id === id)?.boat ?? id;
  const raceName = (id: string) => races.find((item) => item.id === id)?.name ?? id;
  let message: string = event.type;
  if (event.type === 'start') message = `${raceName(event.raceId)} 第${event.attempt}航次：${decisionLabel(event.decision)}${event.boatIds.length ? `（${event.boatIds.map(boat).join('、')}）` : ''}`;
  if (event.type === 'arrival') message = `${raceName(event.raceId)} ${boat(event.boatId)} 到达 ${event.elapsedSeconds}s`;
  if (event.type === 'correction') message = `${raceName(event.raceId)} ${boat(event.boatId)} 改判 ${event.elapsedSeconds}s：${event.reason}`;
  if (event.type === 'race-cancel') message = `${raceName(event.raceId)} 已取消：${event.reason}`;
  if (event.type === 'start-reversal') message = `${raceName(event.raceId)} 第${event.attempt}航次起航被撤销：${event.reason}`;
  if (event.type === 'judge-reversal') message = `黑旗处罚 ${event.penaltyId.slice(0, 8)} 因裁判改判失效`;
  if (event.type === 'publish') message = `${raceName(event.raceId)} 发布正式成绩 v${event.version}`;
  if (event.type === 'protest') message = `抗议 ${event.rule} 更新为 ${event.status}`;
  if (event.type === 'system') message = event.message;
  return <><b>{event.terminalId}</b><div>{message}</div><small>{formatTime(event.occurredAt)}</small></>;
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <AntApp>
      <Layout className="shell">
        <Header className="header">
          <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
          <Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button>
        </Header>
        <Layout>
          <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
            <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
              { key: '/', label: t('control'), icon: <FlagOutlined /> },
              { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
              { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
            ]} />
          </Sider>
          <Content className="content"><Routes>
            <Route path="/" element={<ControlPage />} />
            <Route path="/results" element={<ResultsPage />} />
            <Route path="/protests" element={<ProtestsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes></Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
