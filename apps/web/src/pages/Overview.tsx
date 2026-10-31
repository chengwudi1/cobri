import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Bot, ComputerStatus, Routine, RunActivityRow } from "@rakazo/contracts";
import {
  Badge,
  BotAvatar,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Skeleton,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, CalendarClock, RefreshCw, ShieldAlert, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { SuggestionsCard } from "../components/SuggestionsCard";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { errorText } from "../lib/user-error";
import { statusTone } from "./ActivityList";

const COMPUTER_STATE_TONE: Record<ComputerStatus["state"], string> = {
  stopped: "text-muted-foreground",
  booting: "text-warning",
  running: "text-success",
  suspended: "text-muted-foreground",
  error: "text-destructive",
};

// The demo's main group; if it is gone, show an empty state instead of another group.
const PRIMARY_GROUP_ID = "cmvqvgu05000sbcaf6cojvz47";

function computerStateLabel(state: ComputerStatus["state"]) {
  switch (state) {
    case "stopped":
      return t`Stopped`;
    case "booting":
      return t`Starting`;
    case "running":
      return t`Running`;
    case "suspended":
      return t`Sleeping`;
    case "error":
      return t`Error`;
  }
}

function runStatusLabel(status: RunActivityRow["status"]) {
  switch (status) {
    case "queued":
      return t`Queued`;
    case "leased":
      return t`Leased`;
    case "running":
      return t`Running`;
    case "waiting_input":
      return t`Approvals / input`;
    case "waiting_takeover":
      return t`Waiting for takeover`;
    case "completed":
      return t`Completed`;
    case "failed":
      return t`Failed`;
    case "cancelled":
      return t`Cancelled`;
  }
}

function triggerLabel(trigger: string) {
  switch (trigger) {
    case "user":
      return t`User`;
    case "routine":
      return t`Routine`;
    case "resume":
      return t`Resume`;
    case "follow_up":
      return t`Follow-up`;
    case "reaction":
      return t`Reaction`;
    case "call_end":
      return t`Call ended`;
    case "spawn":
      return t`Spawn`;
    case "skill":
      return t`Skill`;
    case "bot_message":
      return t`Bot message`;
    case "webhook":
      return t`Webhook`;
    case "messaging":
      return t`Message`;
    case "cloud_agent":
      return t`Cloud agent`;
    case "created":
      return t`Created`;
    case "tickets":
      return t`Ticket`;
    default:
      return trigger;
  }
}

function formatCost(value: number | null | undefined) {
  if (value == null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

function formatDateTime(iso: string | null | undefined) {
  if (!iso) return t`Not scheduled`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Field({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 truncate text-[13px] font-medium", tone)}>{value}</div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  detail,
  tone,
  loading = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: string;
  loading?: boolean;
}) {
  return (
    <Card className="gap-2 p-4">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-[12px]">{label}</span>
        {icon}
      </div>
      <div className={cn("text-2xl font-semibold tabular-nums", tone)}>
        {loading ? <Skeleton className="h-7 w-16" data-testid="stat-loading" /> : value}
      </div>
      <div className="truncate text-[11px] text-muted-foreground">{detail}</div>
    </Card>
  );
}

function BotOverviewCard({
  bot,
  routines,
  waitingCount,
}: {
  bot: Bot;
  routines: Routine[];
  waitingCount: number;
}) {
  const queries = useSpaceQueries();
  const computer = useQuery({
    ...queries.computer.status.queryOptions({ input: { botId: bot.id } }),
    refetchInterval: 15_000,
  });
  const botRoutines = routines.filter((routine) => routine.botId === bot.id);
  const activeRoutines = botRoutines.filter((routine) => routine.active);
  const nextRunAt = botRoutines
    .map((routine) => routine.nextRunAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const state = computer.data?.state;
  const computerLabel = computer.isPending
    ? "…"
    : state
      ? computerStateLabel(state)
      : computer.isError
        ? t`Could not read`
        : t`Unknown`;
  const computerTone = state ? COMPUTER_STATE_TONE[state] : "text-muted-foreground";
  const mode =
    computer.data?.mode === "dedicated"
      ? t`Dedicated computer`
      : computer.data?.mode === "team"
        ? t`Team computer`
        : "—";
  const model = bot.modelProvider
    ? `${bot.modelProvider}${bot.modelId ? ` / ${bot.modelId}` : ""}`
    : t`Space default`;
  const routineText = botRoutines.length
    ? `${activeRoutines.length}/${botRoutines.length}${nextRunAt ? ` · ${formatDateTime(nextRunAt)}` : ""}`
    : t`None`;

  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-0">
        <div className="flex min-w-0 items-center gap-3">
          <BotAvatar color={bot.color} identity={bot.id} size={40} status={bot.status} />
          <div className="min-w-0">
            <CardTitle className="truncate text-[15px]">{bot.name}</CardTitle>
            <p className="truncate text-[12px] text-muted-foreground">
              {bot.title || t`Assistant`}
            </p>
          </div>
        </div>
        <Badge variant="outline" className={cn("shrink-0 gap-1.5", computerTone)}>
          <span className="size-1.5 rounded-full bg-current" />
          {computerLabel}
        </Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 pt-1">
        <Field label={t`Computer`} value={mode} />
        <Field label={t`Model`} value={model} />
        <Field label={t`Routines`} value={routineText} />
        <Field
          label={t`Approvals / input`}
          value={String(waitingCount)}
          tone={waitingCount ? "text-warning" : undefined}
        />
        <Link
          to={`/app/${bot.id}`}
          className="col-span-2 mt-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
        >
          <Trans>Open chat</Trans>
        </Link>
      </CardContent>
    </Card>
  );
}

function RecentRunsCard({
  runs,
  loading,
  failed,
  onRetry,
}: {
  runs: RunActivityRow[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const visible = runs.slice(0, 6);
  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row items-center justify-between p-4 pb-2">
        <CardTitle className="text-[15px]">
          <Trans>Recent runs</Trans>
        </CardTitle>
        <Badge variant="secondary">{loading || failed ? "—" : runs.length}</Badge>
      </CardHeader>
      <CardContent className="p-0">
        {failed ? (
          <div className="flex items-center justify-between gap-3 px-4 pb-4">
            <p role="alert" className="text-[12px] text-destructive">
              <Trans>Run data unavailable</Trans>
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : loading && runs.length === 0 ? (
          <div className="flex items-center gap-2 px-4 pb-4 text-muted-foreground">
            <Spinner aria-label={t`Loading runs`} />
            <span className="text-[12px]">
              <Trans>Loading…</Trans>
            </span>
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 pb-4 text-[12px] text-muted-foreground">
            <Trans>No recent runs</Trans>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <caption className="sr-only">
                <Trans>Recent runs</Trans>
              </caption>
              <thead className="border-b border-border text-[11px] text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    <Trans>Bot</Trans>
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    <Trans>Trigger</Trans>
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    <Trans>Status</Trans>
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    <Trans>Updated</Trans>
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    <Trans>Duration</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((run) => (
                  <tr key={run.runId} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2.5">
                      <Link to={`/app/${run.botId}`} className="font-medium hover:underline">
                        {run.botName}
                      </Link>
                      {run.groupName ? (
                        <span className="ms-1 text-[11px] text-muted-foreground">
                          / {run.groupName}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2.5 text-muted-foreground">
                      {triggerLabel(run.trigger)}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2.5 font-medium",
                        statusTone(run.status, run.updatedAt),
                      )}
                    >
                      {runStatusLabel(run.status)}
                    </td>
                    <td className="px-2 py-2.5 text-muted-foreground">
                      {formatRelativeTime(run.updatedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">
                      <Trans>Not provided</Trans>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PendingCard({
  runs,
  loading,
  failed,
  onRetry,
}: {
  runs: RunActivityRow[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between p-4 pb-2">
        <CardTitle className="text-[15px]">
          <Trans>Approvals / input</Trans>
        </CardTitle>
        <Badge variant={runs.length && !loading ? "destructive" : "secondary"}>
          {loading || failed ? "—" : runs.length}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-4 pt-1">
        {failed ? (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="text-[12px] text-destructive">
              <Trans>Run data unavailable</Trans>
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : loading && runs.length === 0 ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner aria-label={t`Loading approvals`} />
            <span className="text-[12px]">
              <Trans>Loading…</Trans>
            </span>
          </div>
        ) : runs.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            <Trans>Nothing pending</Trans>
          </p>
        ) : (
          runs.slice(0, 4).map((run) => (
            <Link
              key={run.runId}
              to={run.groupId ? `/app/g/${run.groupId}` : `/app/${run.botId}`}
              className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5 hover:bg-accent"
            >
              <span className="flex items-center justify-between gap-2 text-[12px] font-medium">
                <span className="truncate">{run.botName}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatRelativeTime(run.updatedAt)}
                </span>
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {run.promptSnippet || <Trans>Waiting for review</Trans>}
              </span>
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function RoutinesCard({ routines }: { routines: Routine[] }) {
  const active = routines.filter((routine) => routine.active).length;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between p-4 pb-2">
        <CardTitle className="text-[15px]">
          <Trans>Routines</Trans>
        </CardTitle>
        <Badge variant="secondary">
          {active}/{routines.length}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-4 pt-1">
        {routines.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            <Trans>No routines</Trans>
          </p>
        ) : (
          routines.slice(0, 5).map((routine) => (
            <div key={routine.id} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium">{routine.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {formatDateTime(routine.nextRunAt)}
                </div>
              </div>
              <span
                className={cn(
                  "shrink-0 text-[11px] font-medium",
                  routine.active ? "text-success" : "text-muted-foreground",
                )}
              >
                {routine.active ? <Trans>Active</Trans> : <Trans>Paused</Trans>}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const bootstrap = useQuery(queries.bootstrap.queryOptions({ input: {} }));
  const active = useQuery({
    ...queries.runs.list.queryOptions({ input: { filter: "active" } }),
    refetchInterval: 15_000,
  });
  const recent = useQuery({
    ...queries.runs.list.queryOptions({ input: { filter: "recent" } }),
    refetchInterval: 15_000,
  });
  const usage = useQuery(queries.usage.summary.queryOptions());

  if (bootstrap.isPending) return <PageLoading />;
  if (bootstrap.isError || !bootstrap.data) {
    return (
      <div className="grid h-full place-items-center bg-background p-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>
              <Trans>Could not load the overview</Trans>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-[13px] text-muted-foreground">
              {errorText(bootstrap.error, t`Could not load this workspace`)}
            </p>
            <Button variant="outline" size="sm" onClick={() => void bootstrap.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const data = bootstrap.data;
  const group = data.groups.find((candidate) => candidate.id === PRIMARY_GROUP_ID);
  if (!group) {
    return (
      <div className="grid h-full place-items-center bg-background p-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>
              <Trans>Demo main group not found</Trans>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-[13px] text-muted-foreground">
              <Trans>Check that the main group still exists. No other group's data is shown.</Trans>
            </p>
            <Button variant="outline" size="sm" onClick={() => void bootstrap.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  const memberIds = new Set(group.members.map((member) => member.botId));
  const teamBots = data.bots.filter((bot) => memberIds.has(bot.id));
  const teamIds = new Set(teamBots.map((bot) => bot.id));
  const activeGroupIds = new Set(
    data.groups.filter((candidate) => !candidate.archivedAt).map((candidate) => candidate.id),
  );
  const isTeamRun = (run: RunActivityRow) =>
    teamIds.has(run.botId) && (run.groupId == null || activeGroupIds.has(run.groupId));
  const routines = data.routines.filter((routine) => teamIds.has(routine.botId));
  const activeRuns = (active.data?.runs ?? []).filter(isTeamRun);
  const waitingRuns = activeRuns.filter((run) => run.status === "waiting_input");
  const recentRuns = (recent.data?.runs ?? []).filter(isTeamRun);
  const activeRoutines = routines.filter((routine) => routine.active).length;
  const usageModels = usage.data?.models
    ?.map((model) => `${model.provider}/${model.model}`)
    .slice(0, 2)
    .join(", ");
  const modelCalls = usage.data?.modelCalls ?? 0;
  const costDetail = usage.isError
    ? t`Usage data unavailable`
    : usage.isPending
      ? t`Loading…`
      : usage.data
        ? `${t`${modelCalls} model calls`}${usageModels ? ` · ${usageModels}` : ""}`
        : "—";

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <header className="app-drag border-b border-border px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              to="/app"
              className="app-no-drag flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <ArrowLeft size={16} strokeWidth={1.9} aria-hidden />
              <Trans>Chats</Trans>
            </Link>
            <div className="min-w-0">
              <h1 className="text-heading2 font-semibold">
                <Trans>Overview</Trans>
              </h1>
              <p className="truncate text-[12px] text-muted-foreground">
                {group.name} · <Trans>Team status</Trans>
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="app-no-drag"
            onClick={() => void queryClient.invalidateQueries()}
          >
            <RefreshCw size={14} />
            <Trans>Refresh</Trans>
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 md:px-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={<ShieldAlert size={16} />}
            label={t`Approvals / input`}
            loading={active.isPending}
            value={active.isError ? "—" : String(waitingRuns.length)}
            detail={
              active.isError
                ? t`Run data unavailable`
                : active.isPending
                  ? t`Loading…`
                  : waitingRuns.length
                    ? t`Needs attention`
                    : t`Nothing pending`
            }
            tone={
              !active.isPending && !active.isError && waitingRuns.length
                ? "text-warning"
                : undefined
            }
          />
          <StatCard
            icon={<Activity size={16} />}
            label={t`Recent runs`}
            loading={recent.isPending}
            value={recent.isError ? "—" : String(recentRuns.length)}
            detail={
              recent.isError
                ? t`Run data unavailable`
                : recent.isPending
                  ? t`Loading…`
                  : t`Latest activity`
            }
          />
          <StatCard
            icon={<CalendarClock size={16} />}
            label={t`Active routines`}
            value={String(activeRoutines)}
            detail={t`${routines.length} total`}
          />
          <StatCard
            icon={<Wallet size={16} />}
            label={t`Model cost`}
            loading={usage.isPending}
            value={usage.isError ? "—" : formatCost(usage.data?.costUsd)}
            detail={costDetail}
          />
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {teamBots.map((bot) => (
            <BotOverviewCard
              key={bot.id}
              bot={bot}
              routines={routines}
              waitingCount={waitingRuns.filter((run) => run.botId === bot.id).length}
            />
          ))}
        </div>
        {teamBots.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-[13px] text-muted-foreground">
              <Trans>No team bots found</Trans>
            </CardContent>
          </Card>
        ) : null}

        <SuggestionsCard />

        <div className="grid gap-4 lg:grid-cols-3">
          <RecentRunsCard
            runs={recentRuns}
            loading={recent.isPending}
            failed={recent.isError}
            onRetry={() => void recent.refetch()}
          />
          <div className="flex flex-col gap-4">
            <PendingCard
              runs={waitingRuns}
              loading={active.isPending}
              failed={active.isError}
              onRetry={() => void active.refetch()}
            />
            <RoutinesCard routines={routines} />
          </div>
        </div>
      </main>
    </div>
  );
}
