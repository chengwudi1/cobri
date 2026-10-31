import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@rakazo/ui-web";
import { UsersRound } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { errorText } from "../../lib/user-error";

/** Mounted only while open; the parent unmounts it from `onCancel` or after creation. */
export function CreateTeamDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (templateId: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const templates = useQuery(queries.teams.listTemplates.queryOptions());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const template = templates.data?.[0];

  async function create() {
    if (!template || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(template.id);
    } catch (reason) {
      setError(errorText(reason, t`Could not create team`));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        data-testid="create-team-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <UsersRound size={17} strokeWidth={1.8} className="text-muted-foreground" aria-hidden="true" />
            <Trans>New team</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Create the bots and their group in one step. You can connect apps afterward.</Trans>
          </DialogDescription>
        </DialogHeader>

        {templates.isPending ? (
          <div className="flex items-center justify-center py-8">
            <Spinner aria-label={t`Loading templates`} />
          </div>
        ) : templates.isError || !template ? (
          <p className="text-[13.5px] text-destructive">
            {errorText(templates.error, t`Could not load team templates`)}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[14px] font-medium text-foreground">{template.name}</p>
              <p className="mt-1 text-[13px] text-muted-foreground">{template.description}</p>
            </div>
            <div className="divide-y divide-border rounded-lg border border-border">
              {template.bots.map((bot) => (
                <div key={bot.key} className="flex items-start gap-3 px-3 py-3">
                  <BotAvatar color={bot.color} identity={`${template.id}-${bot.key}`} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium text-foreground">{bot.name}</p>
                    <p className="mt-0.5 text-[12.5px] text-muted-foreground">{bot.title}</p>
                    <p className="mt-1 text-[12px] text-muted-foreground/80">
                      {bot.tools.join(" · ")}
                    </p>
                    <p className="mt-0.5 text-[12px] text-muted-foreground/80">{bot.approval}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[12.5px] text-muted-foreground">
              <Trans>
                Bots use their own computers and inherit the space model. Connect Gmail, Calendar, or CRM
                after creation to give them tools.
              </Trans>
            </p>
          </div>
        )}

        {error ? (
          <p role="alert" data-testid="create-team-error" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="button"
            disabled={!template || submitting || templates.isPending}
            data-testid="create-team-submit"
            onClick={() => void create()}
          >
            {submitting ? <Trans>Creating…</Trans> : <Trans>Create team</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
