import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Menu,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Typography,
  message
} from 'antd';
import {
  ClockCircleOutlined,
  FlagOutlined,
  LockOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  UndoOutlined
} from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest,
  cancelRace,
  finishRace,
  publishResults,
  registerArrival,
  registerStart,
  revisePenalty,
  signalRecall,
  startRace,
  transitionProtest,
  computeRankings,
  type AppDispatch,
  type RootState
} from './store';
import { useGetOfficialsQuery } from './api';
import type { Boat, Race, StartStatus } from './types';

const { Header, Content, Sider } = Layout;

const protestSchema = z.object({
  raceId: z.string().min(1),
  boatId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function useBoatName() {
  const boats = useSelector((state: RootState) => state.regatta.boats);
  return (boatId: string) => boats.find((b) => b.id === boatId)?.name ?? boatId;
}

function RaceSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const races = useSelector((state: RootState) => state.regatta.races);
  return (
    <Select
      value={value}
      onChange={onChange}
      style={{ width: 300 }}
      options={races.map((r) => ({ value: r.id, label: r.name, disabled: r.status === 'cancelled' }))}
    />
  );
}

function raceStatusColor(status: Race['status']) {
  return status === 'running' ? 'processing' : status === 'finished' ? 'success' : status === 'cancelled' ? 'error' : 'default';
}

/** 起航登记卡片：按场次登记，已确认起航锁定，晚到事件不覆盖 */
function StartRegistration({ race }: { race: Race }) {
  const dispatch = useDispatch<AppDispatch>();
  const boats = useSelector((state: RootState) => state.regatta.boats);
  const [source, setSource] = useState('terminal-A');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const statusOf = (boatId: string) => race.starts.find((s) => s.boatId === boatId);

  return (
    <Card
      title="起航登记"
      extra={
        <Space>
          <Input size="small" addonBefore="终端" value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 150 }} />
          <Button
            size="small"
            icon={<UndoOutlined />}
            onClick={() =>
              dispatch(
                registerStart({
                  raceId: race.id,
                  boatId: 'boat-1',
                  status: 'ocs',
                  source: 'terminal-B',
                  eventId: `sim-late-${Date.now()}`
                })
              )
            }
          >
            模拟另一终端提交
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        pagination={false}
        size="small"
        dataSource={boats}
        columns={[
          { title: '船名', dataIndex: 'name', width: 100 },
          { title: '帆号', dataIndex: 'sailNo', width: 110 },
          {
            title: '起航状态',
            render: (_v, boat: Boat) => {
              const rec = statusOf(boat.id);
              return (
                <Select
                  size="small"
                  style={{ width: 130 }}
                  value={rec?.status ?? 'pending'}
                  disabled={rec?.confirmed || race.status === 'cancelled'}
                  onChange={(val: StartStatus) =>
                    dispatch(registerStart({ raceId: race.id, boatId: boat.id, status: val, source }))
                  }
                  options={[
                    { value: 'pending', label: '未登记' },
                    { value: 'started', label: '正常起航' },
                    { value: 'ocs', label: '抢航 OCS' },
                    { value: 'dns', label: '未起航 DNS' }
                  ]}
                />
              );
            }
          },
          { title: '提交终端', render: (_v, boat: Boat) => statusOf(boat.id)?.source ?? '—', width: 110 },
          {
            title: '确认',
            render: (_v, boat: Boat) => {
              const rec = statusOf(boat.id);
              return rec?.confirmed ? (
                <Tag icon={<LockOutlined />} color="green">
                  已确认
                </Tag>
              ) : (
                <Tag>未确认</Tag>
              );
            },
            width: 90
          },
          {
            title: '登记时间',
            render: (_v, boat: Boat) => {
              const rec = statusOf(boat.id);
              return rec ? new Date(rec.recordedAt).toLocaleTimeString() : '—';
            },
            width: 100
          }
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
        两个终端同时提交同一场时按事件顺序合并，先到的确认结果锁定，晚到记录不能覆盖已确认起航结果；断网恢复后按事件 ID 去重，不重复记罚。
      </Typography.Paragraph>
      <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} style={{ marginTop: 12 }} />
    </Card>
  );
}

/** 到达登记卡片：一般召回只作废未起航船的到达 */
function ArrivalRegistration({ race }: { race: Race }) {
  const dispatch = useDispatch<AppDispatch>();
  const boats = useSelector((state: RootState) => state.regatta.boats);
  const [boatId, setBoatId] = useState(boats[0]?.id);
  const [elapsed, setElapsed] = useState(3200);
  const [penalty, setPenalty] = useState(0);
  const [source, setSource] = useState('terminal-A');

  const submit = () => {
    dispatch(registerArrival({ raceId: race.id, boatId, elapsedSeconds: elapsed, penaltySeconds: penalty, source }));
  };

  return (
    <Card title="到达登记">
      <Space wrap style={{ marginBottom: 12 }}>
        <Select value={boatId} onChange={setBoatId} style={{ width: 160 }} options={boats.map((b) => ({ value: b.id, label: `${b.name} / ${b.sailNo}` }))} />
        <InputNumber addonBefore="净用时(s)" value={elapsed} onChange={(v) => setElapsed(v ?? 0)} min={0} style={{ width: 150 }} />
        <InputNumber addonBefore="处罚(s)" value={penalty} onChange={(v) => setPenalty(v ?? 0)} min={0} style={{ width: 130 }} />
        <Input addonBefore="终端" value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 140 }} />
        <Button type="primary" icon={<PlusOutlined />} onClick={submit} disabled={race.status === 'cancelled'}>
          登记到达
        </Button>
      </Space>
      <Table
        rowKey="id"
        pagination={false}
        size="small"
        dataSource={race.arrivals}
        locale={{ emptyText: '暂无到达记录' }}
        columns={[
          { title: '船名', render: (_v, r) => boats.find((b) => b.id === r.boatId)?.name ?? r.boatId },
          { title: '净用时', dataIndex: 'elapsedSeconds', width: 90 },
          { title: '处罚', dataIndex: 'penaltySeconds', width: 70 },
          {
            title: '状态',
            render: (_v, r) =>
              r.voided ? (
                <Tag color="red">{r.voidReason ?? '已作废'}</Tag>
              ) : (
                <Tag color="green">有效</Tag>
              )
          },
          { title: '终端', dataIndex: 'source', width: 110 },
          { title: '时间', render: (_v, r) => new Date(r.recordedAt).toLocaleTimeString(), width: 100 }
        ]}
      />
    </Card>
  );
}

/** 处罚卡片：黑旗顺延下一个有效场次，改判失效并重算名次 */
function PenaltyCard({ race }: { race: Race }) {
  const dispatch = useDispatch<AppDispatch>();
  const penalties = useSelector((state: RootState) => state.regatta.penalties);
  const races = useSelector((state: RootState) => state.regatta.races);
  const boatName = useBoatName();
  const [reviseTarget, setReviseTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const list = penalties.filter((p) => p.raceId === race.id || p.appliedToRaceId === race.id);
  const raceName = (id?: string) => races.find((r) => r.id === id)?.name ?? '—';

  return (
    <Card title="处罚与顺延" extra={<Tag>{list.length} 条</Tag>}>
      {list.length === 0 ? (
        <Empty description="本场次无处罚" />
      ) : (
        <List
          dataSource={list}
          renderItem={(p) => (
            <List.Item
              actions={[
                <Button
                  key="revise"
                  size="small"
                  danger
                  disabled={p.invalid}
                  onClick={() => {
                    setReviseTarget(p.id);
                    setReason('');
                  }}
                >
                  改判
                </Button>
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Tag color={p.type === 'blackFlag' ? 'black' : 'orange'}>{p.type === 'blackFlag' ? '黑旗' : p.type === 'protest' ? '抗议处罚' : '改判'}</Tag>
                    {p.invalid ? <Tag color="red">已失效</Tag> : p.carryOver && !p.appliedToRaceId ? <Tag color="gold">顺延中</Tag> : p.carryOver ? <Tag color="blue">已顺延执行</Tag> : <Tag>本场执行</Tag>}
                  </Space>
                }
                description={
                  <Space direction="vertical" size={2}>
                    <span>
                      {boatName(p.boatId)} · 原发：{raceName(p.raceId)}
                      {p.appliedToRaceId ? ` → 执行：${raceName(p.appliedToRaceId)}` : ''}
                      {p.penaltySeconds ? ` · 加罚 ${p.penaltySeconds}s` : ''}
                    </span>
                    {p.invalid && <small style={{ color: '#cf1322' }}>{p.invalidReason}</small>}
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}
      <Modal
        title="裁判改判"
        open={!!reviseTarget}
        onOk={() => {
          if (reviseTarget && reason.trim()) {
            dispatch(revisePenalty({ penaltyId: reviseTarget, reason: reason.trim() }));
            setReviseTarget(null);
          }
        }}
        onCancel={() => setReviseTarget(null)}
        okButtonProps={{ disabled: !reason.trim() }}
        okText="确认改判"
        cancelText="取消"
      >
        <Typography.Paragraph>改判将使原处罚失效，名次按有效成绩重算。</Typography.Paragraph>
        <Input.TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="改判原因" />
      </Modal>
    </Card>
  );
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const races = useSelector((state: RootState) => state.regatta.races);
  const [raceId, setRaceId] = useState(races[0]?.id ?? '');
  const race = races.find((r) => r.id === raceId) ?? races[0];
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!race) return <Empty />;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]} align="middle">
        <Col>
          <Space>
            <FlagOutlined />
            <RaceSelect value={race.id} onChange={setRaceId} />
          </Space>
        </Col>
        <Col>
          <Badge status={raceStatusColor(race.status)} text={`状态：${race.status}`} />
        </Col>
        <Col>
          <Tag color={race.recall === 'none' ? 'default' : race.recall === 'general' ? 'orange' : 'red'}>
            {race.recall === 'none' ? '无召回' : race.recall === 'general' ? '一般召回' : '黑旗召回'}
          </Tag>
        </Col>
      </Row>

      <Row gutter={[18, 18]}>
        <Col xs={24} lg={16}>
          <StartRegistration race={race} />
        </Col>
        <Col xs={24} lg={8}>
          <Card title="场次控制">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
              <Descriptions.Item label="距离起航">{countdown(race.startsAt, now)}</Descriptions.Item>
            </Descriptions>
            <Space wrap style={{ marginTop: 12 }}>
              <Button type="primary" onClick={() => dispatch(startRace({ raceId: race.id }))} disabled={race.status === 'cancelled'}>
                开始比赛
              </Button>
              <Button onClick={() => dispatch(finishRace({ raceId: race.id }))} disabled={race.status === 'cancelled'}>
                结束比赛
              </Button>
              <Button
                danger
                onClick={() => {
                  Modal.confirm({
                    title: '取消场次',
                    content: '取消后原发处罚失效，顺延处罚继续顺延到下一个有效场次。确认取消？',
                    okText: '确认取消',
                    okButtonProps: { danger: true },
                    cancelText: '返回',
                    onOk: () => dispatch(cancelRace({ raceId: race.id, reason: '竞赛取消' }))
                  });
                }}
                disabled={race.status === 'cancelled'}
              >
                取消场次
              </Button>
            </Space>
            <Card title="召回信号" size="small" style={{ marginTop: 16 }}>
              <Space wrap>
                <Button
                  onClick={() => dispatch(signalRecall({ raceId: race.id, type: 'general' }))}
                  disabled={race.status === 'cancelled' || race.recall !== 'none'}
                >
                  一般召回
                </Button>
                <Button
                  danger
                  onClick={() => dispatch(signalRecall({ raceId: race.id, type: 'blackFlag' }))}
                  disabled={race.status === 'cancelled' || race.recall !== 'none'}
                >
                  黑旗召回
                </Button>
              </Space>
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
                一般召回只作废该场未起航船的到达成绩；黑旗召回对抢航船处黑旗处罚，顺延到下一个有效场次。
              </Typography.Paragraph>
            </Card>
          </Card>
        </Col>
      </Row>

      <Row gutter={[18, 18]}>
        <Col xs={24} lg={16}>
          <ArrivalRegistration race={race} />
        </Col>
        <Col xs={24} lg={8}>
          <PenaltyCard race={race} />
        </Col>
      </Row>
    </Space>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const races = useSelector((state: RootState) => state.regatta.races);
  const penalties = useSelector((state: RootState) => state.regatta.penalties);
  const boats = useSelector((state: RootState) => state.regatta.boats);
  const [raceId, setRaceId] = useState(races[0]?.id ?? '');
  const race = races.find((r) => r.id === raceId) ?? races[0];
  const [api, contextHolder] = message.useMessage();

  const rankings = useMemo(() => (race ? computeRankings(race, penalties) : []), [race, penalties]);
  if (!race) return <Empty />;

  const frozen = race.versions.some((v) => v.frozen);
  const publish = () => {
    dispatch(publishResults({ raceId: race.id, reason: frozen ? '裁判改判' : undefined }));
    api.success(frozen ? '已另开新版本并冻结，旧版保留' : '正式成绩已发布并冻结');
  };

  return (
    <>
      {contextHolder}
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Row gutter={[18, 18]} align="middle">
          <Col>
            <RaceSelect value={race.id} onChange={setRaceId} />
          </Col>
          <Col>
            <Tag color={raceStatusColor(race.status)}>{race.status}</Tag>
          </Col>
          <Col>
            <Button type="primary" onClick={publish} disabled={race.status === 'cancelled' || rankings.length === 0}>
              {frozen ? '改判并发布新版本' : '发布正式成绩'}
            </Button>
          </Col>
        </Row>

        <Card title="名次（按有效成绩重算）">
          <Table
            rowKey="boatId"
            pagination={false}
            size="small"
            dataSource={rankings}
            locale={{ emptyText: '暂无有效成绩' }}
            columns={[
              { title: '名次', dataIndex: 'rank', width: 70 },
              { title: '船名', render: (_v, r) => boats.find((b) => b.id === r.boatId)?.name ?? r.boatId },
              { title: '帆号', render: (_v, r) => boats.find((b) => b.id === r.boatId)?.sailNo ?? '' },
              { title: '净用时(s)', dataIndex: 'elapsedSeconds', width: 100 },
              { title: '处罚(s)', dataIndex: 'penaltySeconds', width: 90 },
              { title: '总用时(s)', dataIndex: 'totalSeconds', width: 100, render: (v: number) => (Number.isFinite(v) ? v : '—') },
              {
                title: '状态',
                render: (_v, r) =>
                  r.status === 'finished' ? <Tag color="green">有效</Tag> : <Tag color="black">DSQ</Tag>
              }
            ]}
          />
        </Card>

        <Card title="成绩版本">
          {race.versions.length === 0 ? (
            <Empty description="尚未发布正式成绩" />
          ) : (
            <List
              dataSource={race.versions}
              renderItem={(v) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space>
                        <Tag color="blue">第 {v.version} 版</Tag>
                        {v.frozen ? <Tag icon={<LockOutlined />} color="green">已冻结</Tag> : <Tag>临时</Tag>}
                        {v.reason && <Tag color="orange">{v.reason}</Tag>}
                      </Space>
                    }
                    description={
                      <span>
                        {v.publishedAt ? new Date(v.publishedAt).toLocaleString() : '未发布'} · {v.results.length} 条成绩
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
      </Space>
    </>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const races = useSelector((state: RootState) => state.regatta.races);
  const boats = useSelector((state: RootState) => state.regatta.boats);
  const boatName = useBoatName();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors }
  } = useForm<z.infer<typeof protestSchema>>({
    resolver: zodResolver(protestSchema),
    defaultValues: { raceId: races[0]?.id, boatId: boats[0]?.id, reason: '', rule: 'RRS 14' }
  });
  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest(values));
    reset({ raceId: values.raceId, boatId: values.boatId, reason: '', rule: 'RRS 14' });
  };
  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={9}>
        <Card title="提交抗议">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="场次" validateStatus={errors.raceId ? 'error' : undefined}>
              <select className="native-select" {...register('raceId')}>
                {races.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Form.Item>
            <Form.Item label="参赛船" validateStatus={errors.boatId ? 'error' : undefined}>
              <select className="native-select" {...register('boatId')}>
                {boats.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} / {b.sailNo}
                  </option>
                ))}
              </select>
            </Form.Item>
            <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}>
              <Input {...register('rule')} />
            </Form.Item>
            <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}>
              <Input.TextArea rows={4} {...register('reason')} />
            </Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>
              登记抗议
            </Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={9}>
        <Card title="冲突复核队列">
          {protests.length === 0 ? (
            <Empty />
          ) : (
            <List
              dataSource={protests}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <Button key="review" size="small" onClick={() => dispatch(transitionProtest({ id: item.id, status: 'reviewing' }))}>
                      进入复核
                    </Button>,
                    <Button
                      key="accept"
                      size="small"
                      type="primary"
                      onClick={() => dispatch(transitionProtest({ id: item.id, status: 'resolved', decision: '接受抗议并处以30秒处罚', penaltySeconds: 30 }))}
                    >
                      接受并处罚
                    </Button>,
                    <Button key="reject" size="small" danger onClick={() => dispatch(transitionProtest({ id: item.id, status: 'rejected', decision: '证据不足，维持原成绩' }))}>
                      驳回
                    </Button>
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        <Tag color={item.status === 'reviewing' ? 'processing' : 'default'}>{item.status}</Tag>
                        {item.rule}
                      </Space>
                    }
                    description={
                      <>
                        <div>{item.reason}</div>
                        <small>
                          {races.find((r) => r.id === item.raceId)?.name} · {boatName(item.boatId)}
                        </small>
                      </>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card title="事件时间线">
          <Timeline
            items={timeline.map((event) => ({
              color: event.type === 'protest' ? 'orange' : event.type === 'penalty' ? 'red' : event.type === 'system' ? 'gray' : 'blue',
              children: (
                <>
                  <b>{event.type}</b>
                  <div>{event.message}</div>
                  <small>{new Date(event.time).toLocaleTimeString()}</small>
                </>
              )
            }))}
          />
        </Card>
      </Col>
    </Row>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data = [] } = useGetOfficialsQuery();
  return (
    <AntApp>
      <Layout className="shell">
        <Header className="header">
          <Space>
            <SafetyCertificateOutlined style={{ fontSize: 24 }} />
            <Typography.Title level={4} style={{ margin: 0, color: 'white' }}>
              {t('title')}
            </Typography.Title>
          </Space>
          <Space>
            <Tag>{data.length} 名值班人员</Tag>
            <Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>
              {t('language')}
            </Button>
          </Space>
        </Header>
        <Layout>
          <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
            <Menu
              mode="inline"
              selectedKeys={[location.pathname]}
              onClick={({ key }) => navigate(key)}
              items={[
                { key: '/', label: t('control'), icon: <FlagOutlined /> },
                { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
                { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
              ]}
            />
          </Sider>
          <Content className="content">
            <Routes>
              <Route path="/" element={<ControlPage />} />
              <Route path="/results" element={<ResultsPage />} />
              <Route path="/protests" element={<ProtestsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
