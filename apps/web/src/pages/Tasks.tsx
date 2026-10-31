import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Artifact, Bot, RunActivityRow } from "@rakazo/contracts";
import {
  Badge,
  BotAvatar,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowLeftRight, FileText, RefreshCw, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { errorText } from "../lib/user-error";
import { statusTone } from "./ActivityList";

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
    case "follow_up":
      return t`Handoff`;
    case "bot_message":
      return t`Bot message`;
    case "webhook":
      return t`Webhook`;
    default:
      return trigger;
  }
}

function promptLabel(run: RunActivityRow) {
  const text = run.promptSnippet?.trim();
  if (!text) return t`No prompt`;
  if (/^(?:\[bot\]|Message from another agent|A message just arrived)/i.test(text)) {
    return t`Handoff from another bot`;
  }
  return text;
}

function runHref(run: RunActivityRow) {
  return run.groupId ? `/app/g/${run.groupId}` : `/app/${run.botId}`;
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function SummaryCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <Card className="gap-3 border-border bg-card py-4">
      <CardHeader className="flex flex-row items-center justify-between px-5 pb-0">
        <CardTitle className="text-[13px] font-medium text-muted-foreground">{label}</CardTitle>
        <span className="text-muted-foreground/70">{icon}</span>
      </CardHeader>
      <CardContent className="px-5">
        <p className="text-[26px] font-semibold leading-none tracking-tight text-foreground">{value}</p>
        <p className="mt-2 text-[12.5px] text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function RunRow({ run, bot }: { run: RunActivityRow; bot: Bot | undefined }) {
  return (
    <Link
      to={runHref(run)}
      className="flex items-start gap-3 border-b border-border/70 px-5 py-3 last:border-b-0 hover:bg-muted/40"
    >
      <BotAvatar
        color={bot?.color ?? "#999999"}
        identity={run.botId}
        size={26}
        status={bot?.status}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-foreground">{run.botName}</span>
          <Badge variant="secondary" className="shrink-0 text-[11px]">
            {triggerLabel(run.trigger)}
          </Badge>
          {run.groupName ? (
            <span className="truncate text-[12px] text-muted-foreground">{run.groupName}</span>
          ) : null}
        </div>
        <p className="mt-1 line-clamp-2 text-[12.5px] text-muted-foreground">
          {promptLabel(run)}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className={`text-[12px] ${statusTone(run.status, run.updatedAt)}`}>
          {runStatusLabel(run.status)}
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          {formatRelativeTime(run.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

function ArtifactRow({
  artifact,
  bot,
}: {
  artifact: Artifact & { versionCount?: number };
  bot: Bot | undefined;
}) {
  return (
    <Link
      to={`/app/artifacts/${artifact.id}`}
      className="flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-b-0 hover:bg-muted/40"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
        <FileText size={16} strokeWidth={1.8} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium text-foreground">{artifact.name}</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {bot?.name ?? t`Unknown bot`} · {formatBytes(artifact.size)}
        </p>
      </div>
      <span className="shrink-0 text-[11.5px] text-muted-foreground">
        {formatRelativeTime(artifact.createdAt)}
      </span>
    </Link>
  );
}

export function TasksPage() {
  const queries = useSpaceQueries();
  const bootstrap = useQuery(queries.bootstrap.queryOptions({ input: {} }));
  const active = useQuery({
    ...queries.runs.list.queryOptions({ input: { filter: "active" } }),
    refetchInterval: 15_000,
  });
  const recent = useQuery({
    ...queries.runs.list.queryOptions({ input: { filter: "recent" } }),
    refetchInterval: 15_000,
  });
  const artifacts = useQuery(
    queries.artifacts.listSpace.queryOptions({ input: { limit: 8 } }),
  );

  if (bootstrap.isPending) return <PageLoading />;
  if (bootstrap.isError || !bootstrap.data) {
    return (
      <div className="grid h-full place-items-center bg-background p-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>
              <Trans>Could not load tasks</Trans>
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
  const bots = new Map(data.bots.map((bot) => [bot.id, bot]));
  const activeGroupIds = new Set(
    data.groups.filter((group) => !group.archivedAt).map((group) => group.id),
  );
  const visible = (run: RunActivityRow) =>
    run.groupId == null || activeGroupIds.has(run.groupId);
  const activeRuns = (active.data?.runs ?? []).filter(visible);
  const recentRuns = (recent.data?.runs ?? []).filter(visible);
  const waitingRuns = activeRuns.filter((run) => run.status === "waiting_input");
  const doingRuns = activeRuns.filter((run) => run.status !== "waiting_input");
  const handoffs = recentRuns
    .filter((run) => run.trigger === "follow_up" || run.trigger === "bot_message")
    .slice(0, 6);
  const spaceArtifacts = (artifacts.data?.items ?? [])
    .filter((artifact) => artifact.groupId == null || activeGroupIds.has(artifact.groupId))
    .slice(0, 6);
  const loadingRuns = active.isPending || recent.isPending;

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-5 px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Link
              to="/app"
              aria-label={t`Back to chats`}
              className="mt-1 text-muted-foreground/70 hover:text-foreground"
            >
              <ArrowLeft size={17} strokeWidth={1.8} aria-hidden="true" />
            </Link>
            <div>
              <h1 className="text-[22px] font-semibold tracking-tight">
                <Trans>Tasks</Trans>
              </h1>
              <p className="mt-1 text-[13px] text-muted-foreground">
                <Trans>Who is doing what, where the output is, and what is waiting on you.</Trans>
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void active.refetch();
              void recent.refetch();
              void artifacts.refetch();
            }}
          >
            <RefreshCw size={14} strokeWidth={1.8} aria-hidden="true" />
            <Trans>Refresh</Trans>
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard
            label={t`Doing now`}
            value={loadingRuns ? "—" : String(doingRuns.length)}
            detail={t`Bots with an active run`}
            icon={<Activity size={16} strokeWidth={1.8} aria-hidden="true" />}
          />
          <SummaryCard
            label={t`Waiting on you`}
            value={loadingRuns ? "—" : String(waitingRuns.length)}
            detail={t`Approvals or input`}
            icon={<ShieldAlert size={16} strokeWidth={1.8} aria-hidden="true" />}
          />
          <SummaryCard
            label={t`Recent handoffs`}
            value={loadingRuns ? "—" : String(handoffs.length)}
            detail={t`Bot-to-bot work`}
            icon={<ArrowLeftRight size={16} strokeWidth={1.8} aria-hidden="true" />}
          />
          <SummaryCard
            label={t`Artifacts`}
            value={artifacts.isPending ? "—" : String(spaceArtifacts.length)}
            detail={t`Files saved by bots`}
            icon={<FileText size={16} strokeWidth={1.8} aria-hidden="true" />}
          />
        </div>

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div>
              <h2 className="text-[14px] font-medium">
                <Trans>Doing now</Trans>
              </h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                <Trans>Active runs across the team</Trans>
              </p>
            </div>
            {active.isError ? (
              <span className="text-[12px] text-destructive">{t`Could not load runs`}</span>
            ) : null}
          </div>
          {loadingRuns && doingRuns.length === 0 ? (
            <div className="flex justify-center py-8">
              <Spinner aria-label={t`Loading runs`} />
            </div>
          ) : doingRuns.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">
              <Trans>No active runs right now.</Trans>
            </p>
          ) : (
            doingRuns.map((run) => <RunRow key={run.runId} run={run} bot={bots.get(run.botId)} />)
          )}
        </section>

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div>
              <h2 className="text-[14px] font-medium">
                <Trans>Waiting on you</Trans>
              </h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                <Trans>Runs stopped at an approval or a question</Trans>
              </p>
            </div>
          </div>
          {waitingRuns.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">
              <Trans>Nothing is waiting on you.</Trans>
            </p>
          ) : (
            waitingRuns.map((run) => <RunRow key={run.runId} run={run} bot={bots.get(run.botId)} />)
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-5 py-3">
              <h2 className="text-[14px] font-medium">
                <Trans>Recent handoffs</Trans>
              </h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                <Trans>Work passed between bots</Trans>
              </p>
            </div>
            {handoffs.length === 0 ? (
              <p className="px-5 py-6 text-[13px] text-muted-foreground">
                <Trans>No handoffs recently.</Trans>
              </p>
            ) : (
              handoffs.map((run) => <RunRow key={run.runId} run={run} bot={bots.get(run.botId)} />)
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-5 py-3">
              <h2 className="text-[14px] font-medium">
                <Trans>Artifacts</Trans>
              </h2>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                <Trans>Files saved by the team</Trans>
              </p>
            </div>
            {artifacts.isPending && spaceArtifacts.length === 0 ? (
              <div className="flex justify-center py-8">
                <Spinner aria-label={t`Loading artifacts`} />
              </div>
            ) : spaceArtifacts.length === 0 ? (
              <p className="px-5 py-6 text-[13px] text-muted-foreground">
                <Trans>No artifacts yet.</Trans>
              </p>
            ) : (
              spaceArtifacts.map((artifact) => (
                <ArtifactRow
                  key={artifact.id}
                  artifact={artifact}
                  bot={artifact.botId ? bots.get(artifact.botId) : undefined}
                />
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
