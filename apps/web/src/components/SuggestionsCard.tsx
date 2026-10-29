import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProactiveSuggestion } from "@rakazo/contracts";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

function sourceLabel(source: string) {
  switch (source) {
    case "gmail":
      return t`Gmail`;
    case "calendar":
      return t`Calendar`;
    case "crm":
      return t`CRM`;
    default:
      return source;
  }
}

export function SuggestionsCard() {
  const queries = useSpaceQueries();
  const rpc = useSpaceRpc();
  const queryClient = useQueryClient();
  const suggestions = useQuery(queries.suggestions.list.queryOptions());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = (suggestions.data ?? []).filter(
    (suggestion: ProactiveSuggestion) => suggestion.status === "pending",
  );

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: queries.suggestions.list.queryKey() });
  }

  async function generate() {
    if (busy) return;
    setBusy("generate");
    setError(null);
    try {
      await rpc.suggestions.generate();
      await refresh();
    } catch (failure) {
      setError(errorText(failure, t`Could not generate suggestions`));
    } finally {
      setBusy(null);
    }
  }

  async function accept(id: string) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await rpc.suggestions.accept({ id });
      await refresh();
    } catch (failure) {
      setError(errorText(failure, t`Could not dispatch this suggestion`));
    } finally {
      setBusy(null);
    }
  }

  async function ignore(id: string) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await rpc.suggestions.ignore({ id });
      await refresh();
    } catch (failure) {
      setError(errorText(failure, t`Could not ignore this suggestion`));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-[15px]">
              <Trans>Suggestions</Trans>
            </CardTitle>
            <Badge variant="outline">
              <Sparkles size={12} aria-hidden />
              <Trans>Primary Bot</Trans>
            </Badge>
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            <Trans>The Primary Bot scans your local inbox, calendar, and CRM.</Trans>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={busy !== null}
          onClick={() => void generate()}
        >
          {busy === "generate" ? <Trans>Scanning…</Trans> : <Trans>Scan now</Trans>}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-4 pt-1">
        {suggestions.isPending ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner aria-label={t`Loading suggestions`} />
            <span className="text-[12px]">
              <Trans>Loading…</Trans>
            </span>
          </div>
        ) : suggestions.isError ? (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="text-[12px] text-destructive">
              {errorText(suggestions.error, t`Could not load suggestions`)}
            </p>
            <Button variant="outline" size="sm" onClick={() => void suggestions.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : pending.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            <Trans>No pending suggestions</Trans>
          </p>
        ) : (
          pending.slice(0, 3).map((suggestion) => (
            <div
              key={suggestion.id}
              className="rounded-xl border border-border p-3"
              data-testid="suggestion-card"
            >
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{sourceLabel(suggestion.source)}</Badge>
                <span className="text-[11px] text-muted-foreground">
                  <Trans>For</Trans> {suggestion.botName}
                </span>
              </div>
              <div className="mt-1 text-[13px] font-medium">{suggestion.title}</div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                {suggestion.rationale}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <BotAvatar
                  color={suggestion.botColor}
                  identity={suggestion.botId}
                  size={18}
                  status="idle"
                />
                <span className="text-[12px] text-muted-foreground">{suggestion.botName}</span>
                <span className="flex-1" />
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void accept(suggestion.id)}
                >
                  {busy === suggestion.id
                    ? <Trans>Working…</Trans>
                    : t`Hand to ${suggestion.botName}`}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void ignore(suggestion.id)}
                >
                  <Trans>Ignore</Trans>
                </Button>
              </div>
            </div>
          ))
        )}
        {error ? (
          <p role="alert" className="text-[12px] text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
