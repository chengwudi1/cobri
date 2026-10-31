import { ORPCError } from "@orpc/server";
import type { Group } from "@rakazo/contracts";
import { getTeamTemplate, TEAM_TEMPLATES } from "@rakazo/core";
import { ComputerLimitError, SpaceDeletionInProgressError } from "@rakazo/db";
import type { RouterContext } from "./context.js";

function mapSpaceLifecycleError(error: unknown): unknown {
  if (error instanceof SpaceDeletionInProgressError) {
    return new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof ComputerLimitError) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  return error;
}

function hasExactMembers(group: Group, botIds: string[]): boolean {
  const members = new Set(group.members.map((member) => member.botId));
  return members.size === botIds.length && botIds.every((botId) => members.has(botId));
}

function availableGroupName(base: string, groups: Group[]): string {
  if (!groups.some((group) => group.name === base)) return base;
  let index = 2;
  while (groups.some((group) => group.name === `${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

export function teamsRoutes(ctx: RouterContext) {
  const { repos, groupRepos, authed } = ctx;
  return {
    teams: {
      listTemplates: authed.teams.listTemplates.handler(async () =>
        TEAM_TEMPLATES.map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
          groupName: template.groupName,
          bots: template.bots.map((bot) => ({
            key: bot.key,
            name: bot.name,
            title: bot.title,
            description: bot.description,
            color: bot.color,
            tools: bot.tools,
            approval: bot.approval,
          })),
        })),
      ),
      create: authed.teams.create.handler(async ({ context, input }) => {
        const template = getTeamTemplate(input.templateId);
        if (!template) throw new ORPCError("NOT_FOUND", { message: "Unknown team template" });
        const bots = [];
        for (const spec of template.bots) {
          try {
            const created = await repos.createBot(context.actor, {
              name: spec.name,
              title: spec.title,
              description: spec.description,
              instructions: spec.instructions,
              notifyOnFinish: true,
              color: spec.color,
              // Retrying a half-created team reuses each bot instead of cloning it.
              spawnKey: `team:${template.id}:${spec.key}`,
            });
            bots.push(await repos.setBotComputer(context.actor, created.id, "dedicated"));
          } catch (error) {
            throw mapSpaceLifecycleError(error);
          }
        }
        const botIds = bots.map((bot) => bot.id);
        const groups = await groupRepos.listGroups(context.actor);
        const existing = groups.find((group) => hasExactMembers(group, botIds));
        const group =
          existing ??
          (await groupRepos
            .createGroup(context.actor, {
              name: availableGroupName(template.groupName, groups),
              botIds,
            })
            .catch((error: unknown) => {
              throw mapSpaceLifecycleError(error);
            }));
        return { group, bots };
      }),
    },
  };
}
