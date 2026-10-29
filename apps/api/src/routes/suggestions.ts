import { ORPCError } from "@orpc/server";
import type { ProactiveSuggestion } from "@rakazo/contracts";
import { SUGGESTION_BOT_NAMES } from "../suggestions-config.js";
import { resolveThreadTarget, sendThreadMessage } from "../thread-target.js";
import type { RouterContext } from "./context.js";

type Candidate = {
  source: "gmail" | "calendar" | "crm";
  title: string;
  rationale: string;
  instruction: string;
  botName: string;
};

type GmailMessage = {
  from?: string;
  subject?: string;
  body?: string;
  urgent?: boolean;
  deadline?: string | null;
  needsConfirmation?: boolean;
};

type CalendarEvent = {
  summary?: string;
  startLocal?: string;
  endLocal?: string;
  attendees?: string[];
};

type CrmContact = {
  id?: string;
  name?: string;
  contractAmountText?: string;
  priority?: string;
};

type CrmNote = { contactId?: string };

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function localSource(source: string): boolean {
  try {
    const host = new URL(source).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function sourceUrl(source: string, path: string) {
  return `${source.replace(/\/$/, "")}${path}`;
}

export function suggestionsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  async function botLookup(actor: { spaceId: string; userId: string }) {
    const bots = await deps.prisma.bot.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true, name: true, color: true },
    });
    return new Map(bots.map((bot) => [bot.name, bot]));
  }

  function mapSuggestion(
    row: {
      id: string;
      spaceId: string;
      userId: string;
      botId: string;
      source: string;
      title: string;
      rationale: string;
      instruction: string;
      status: string;
      runId: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    bot: { name: string; color: string } | undefined,
  ): ProactiveSuggestion {
    return {
      id: row.id,
      spaceId: row.spaceId,
      userId: row.userId,
      botId: row.botId,
      botName: bot?.name ?? "Unknown",
      botColor: bot?.color ?? "",
      source: row.source,
      title: row.title,
      rationale: row.rationale,
      instruction: row.instruction,
      status: row.status as ProactiveSuggestion["status"],
      runId: row.runId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function listSuggestions(actor: { spaceId: string; userId: string }) {
    const rows = await deps.prisma.proactiveSuggestion.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const bots = await botLookup(actor);
    const byId = new Map([...bots.values()].map((bot) => [bot.id, bot]));
    return rows.map((row) => mapSuggestion(row, byId.get(row.botId)));
  }

  return {
    suggestions: {
      list: authed.suggestions.list.handler(async ({ context }) =>
        listSuggestions(context.actor),
      ),
      generate: authed.suggestions.generate.handler(async ({ context }) => {
        const { actor } = context;
        const installs = await deps.prisma.capabilityInstall.findMany({
          where: { spaceId: actor.spaceId, userId: actor.userId, kind: "api" },
          select: { name: true, source: true },
        });
        const gmailSource = installs.find(
          (install) => /gmail/i.test(install.name) && localSource(install.source),
        )?.source;
        const calendarSource = installs.find(
          (install) => /calendar/i.test(install.name) && localSource(install.source),
        )?.source;
        const crmSource = installs.find(
          (install) => /crm/i.test(install.name) && localSource(install.source),
        )?.source;

        const [gmailPayload, calendarPayload, contactsPayload, notesPayload] = await Promise.all([
          gmailSource
            ? fetchJson<{ messages?: GmailMessage[] }>(sourceUrl(gmailSource, "/messages"))
            : null,
          calendarSource
            ? fetchJson<{ events?: CalendarEvent[] }>(sourceUrl(calendarSource, "/events"))
            : null,
          crmSource ? fetchJson<{ contacts?: CrmContact[] }>(sourceUrl(crmSource, "/contacts")) : null,
          crmSource ? fetchJson<{ notes?: CrmNote[] }>(sourceUrl(crmSource, "/notes")) : null,
        ]);

        const bots = await botLookup(actor);
        const candidates: Candidate[] = [];

        const messages = gmailPayload?.messages ?? [];
        const urgentMessage =
          messages.find((message) => message.needsConfirmation) ??
          messages.find((message) => message.urgent);
        if (urgentMessage?.subject && bots.has(SUGGESTION_BOT_NAMES.inbox)) {
          candidates.push({
            source: "gmail",
            title: `确认：${urgentMessage.subject}`,
            rationale: `${urgentMessage.from ?? "收件箱"} 发来「${urgentMessage.subject}」，${
              urgentMessage.deadline ? `截止 ${urgentMessage.deadline}，` : ""
            }需要确认。`,
            instruction: `请检查收件箱中的「${urgentMessage.subject}」，确认时间、议题和待办，并准备回复草稿；不要直接发送。`,
            botName: SUGGESTION_BOT_NAMES.inbox,
          });
        }

        const contacts = contactsPayload?.contacts ?? [];
        const contactNames = contacts
          .map((contact) => contact.name)
          .filter((name): name is string => Boolean(name));
        const events = calendarPayload?.events ?? [];
        const nextEvent =
          events.find((event) =>
            contactNames.some((name) => (event.summary ?? "").includes(name)),
          ) ?? events[0];
        if (nextEvent?.summary && bots.has(SUGGESTION_BOT_NAMES.calendar)) {
          candidates.push({
            source: "calendar",
            title: `准备：${nextEvent.summary} 议程`,
            rationale: `${nextEvent.startLocal ?? "待定"}–${nextEvent.endLocal ?? "待定"} 的「${nextEvent.summary}」，参会人：${(nextEvent.attendees ?? []).join("、") || "未注明"}。`,
            instruction: `请检查日历中的「${nextEvent.summary}」，准备议程、参会人确认和冲突提醒；先不要修改日历。`,
            botName: SUGGESTION_BOT_NAMES.calendar,
          });
        }

        const highPriorityContact =
          contacts.find((contact) => contact.priority === "high") ?? contacts[0];
        const hasNote = Boolean(
          highPriorityContact?.id &&
            (notesPayload?.notes ?? []).some((note) => note.contactId === highPriorityContact.id),
        );
        if (
          highPriorityContact?.name &&
          !hasNote &&
          bots.has(SUGGESTION_BOT_NAMES.inbox)
        ) {
          candidates.push({
            source: "crm",
            title: `跟进：${highPriorityContact.name}`,
            rationale: `${highPriorityContact.name} 是${highPriorityContact.priority === "high" ? "高优先级" : ""}客户，合同 ${highPriorityContact.contractAmountText ?? "金额未注明"}，CRM 暂无跟进记录。`,
            instruction: `请根据收件箱和日历整理「${highPriorityContact.name}」的待跟进事项，给出下一步建议；先不要写 CRM。`,
            botName: SUGGESTION_BOT_NAMES.inbox,
          });
        }

        if (candidates.length === 0) {
          throw new ORPCError("BAD_REQUEST", {
            message: "No reachable local Gmail, Calendar, or CRM data source was found.",
          });
        }

        const data = candidates.slice(0, 3).flatMap((candidate) => {
          const bot = bots.get(candidate.botName);
          if (!bot) return [];
          return [
            {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: bot.id,
              source: candidate.source,
              title: candidate.title,
              rationale: candidate.rationale,
              instruction: candidate.instruction,
              status: "pending",
            },
          ];
        });
        const created =
          data.length > 0
            ? (
                await deps.prisma.proactiveSuggestion.createMany({
                  data,
                  skipDuplicates: true,
                })
              ).count
            : 0;

        return { suggestions: await listSuggestions(actor), created };
      }),
      ignore: authed.suggestions.ignore.handler(async ({ context, input }) => {
        const { actor } = context;
        const claimed = await deps.prisma.proactiveSuggestion.updateMany({
          where: {
            id: input.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            status: "pending",
          },
          data: { status: "ignored" },
        });
        if (claimed.count === 0) {
          const current = await deps.prisma.proactiveSuggestion.findFirst({
            where: { id: input.id, spaceId: actor.spaceId, userId: actor.userId },
          });
          if (!current) throw new ORPCError("NOT_FOUND", { message: "Suggestion not found." });
          throw new ORPCError("CONFLICT", {
            message: "Suggestion is no longer pending.",
          });
        }
        const row = await deps.prisma.proactiveSuggestion.findFirst({
          where: { id: input.id, spaceId: actor.spaceId, userId: actor.userId },
        });
        if (!row) throw new ORPCError("NOT_FOUND", { message: "Suggestion not found." });
        const bots = await botLookup(actor);
        return mapSuggestion(row, [...bots.values()].find((bot) => bot.id === row.botId));
      }),
      accept: authed.suggestions.accept.handler(async ({ context, input }) => {
        const { actor } = context;
        const row = await deps.prisma.proactiveSuggestion.findFirst({
          where: { id: input.id, spaceId: actor.spaceId, userId: actor.userId },
        });
        if (!row) throw new ORPCError("NOT_FOUND", { message: "Suggestion not found." });
        const bots = await botLookup(actor);
        const bot = [...bots.values()].find((candidate) => candidate.id === row.botId);
        if (!bot) throw new ORPCError("NOT_FOUND", { message: "Target bot not found." });

        const claimed = await deps.prisma.proactiveSuggestion.updateMany({
          where: {
            id: row.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            status: "pending",
          },
          data: { status: "accepted" },
        });
        if (claimed.count === 0) {
          throw new ORPCError("CONFLICT", {
            message: "Suggestion is no longer pending.",
          });
        }

        try {
          const target = await resolveThreadTarget(deps.prisma, actor, { botId: bot.id });
          const sent = await sendThreadMessage(
            deps,
            actor,
            target,
            {
              text: `${row.title}\n\n${row.instruction}\n\nReason: ${row.rationale}`,
              clientNonce: `suggestion:${row.id}`,
            },
          );
          const updated = await deps.prisma.proactiveSuggestion.update({
            where: { id: row.id },
            data: { runId: sent.runId },
          });
          return mapSuggestion(updated, bot);
        } catch (error) {
          await deps.prisma.proactiveSuggestion.updateMany({
            where: {
              id: row.id,
              spaceId: actor.spaceId,
              userId: actor.userId,
              status: "accepted",
              runId: null,
            },
            data: { status: "pending" },
          });
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: error instanceof Error ? error.message : "Could not dispatch this suggestion.",
          });
        }
      }),
    },
  };
}
