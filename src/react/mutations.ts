import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type AgentSwitchesResponse,
  type CapabilitySwitchesResponse,
  type CreateNoteParams,
  createConversation,
  createNote,
  deleteConversation,
  invalidateConvoDetailCache,
  setAgentActive,
  setAgentAvailability,
  setCapabilityActive,
  setCapabilityAvailability,
  setCustomAgentsEnabled,
  type UpdateConversationPatch,
  updateConversation,
} from "../api/index.js";
import { bbKeys } from "./keys.js";
import { useBBContext } from "./provider.js";

// ── agent toggles ─────────────────────────────────────────────────────────────────

/**
 * Toggle an agent's `active` flag with an optimistic update.
 * cancel → snapshot → optimistic write → rollback on error → reconcile on settle.
 */
export function useSetAgentActive(targetOrgId?: string) {
  const { getAuthContext, orgId } = useBBContext();
  const scope = targetOrgId ?? orgId;
  const qc = useQueryClient();
  const key = bbKeys(scope).agents.list;

  return useMutation({
    mutationFn: ({ agentId, active }: { agentId: string; active: boolean }) =>
      setAgentActive(getAuthContext(), agentId, active, targetOrgId),
    onMutate: async ({ agentId, active }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<AgentSwitchesResponse>(key);
      if (previous) {
        const current = previous[agentId];
        if (current) {
          qc.setQueryData<AgentSwitchesResponse>(key, {
            ...previous,
            [agentId]: { ...current, active },
          });
        }
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** Toggle an agent's `available` flag. */
export function useSetAgentAvailability(targetOrgId?: string) {
  const { getAuthContext, orgId } = useBBContext();
  const scope = targetOrgId ?? orgId;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, available }: { agentId: string; available: boolean }) =>
      setAgentAvailability(getAuthContext(), agentId, available, targetOrgId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bbKeys(scope).agents.list });
    },
  });
}

// ── capability toggles ─────────────────────────────────────────────────────────────

/** Toggle a capability's `active` flag with an optimistic update. */
export function useSetCapabilityActive(targetOrgId?: string) {
  const { getAuthContext, orgId } = useBBContext();
  const scope = targetOrgId ?? orgId;
  const qc = useQueryClient();
  const key = bbKeys(scope).capabilities.list;

  return useMutation({
    mutationFn: ({ capabilityId, active }: { capabilityId: string; active: boolean }) =>
      setCapabilityActive(getAuthContext(), capabilityId, active, targetOrgId),
    onMutate: async ({ capabilityId, active }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<CapabilitySwitchesResponse>(key);
      if (previous) {
        const current = previous[capabilityId];
        if (current) {
          qc.setQueryData<CapabilitySwitchesResponse>(key, {
            ...previous,
            [capabilityId]: { ...current, active },
          });
        }
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** Toggle a capability's `available` flag. */
export function useSetCapabilityAvailability(targetOrgId?: string) {
  const { getAuthContext, orgId } = useBBContext();
  const scope = targetOrgId ?? orgId;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ capabilityId, available }: { capabilityId: string; available: boolean }) =>
      setCapabilityAvailability(getAuthContext(), capabilityId, available, targetOrgId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bbKeys(scope).capabilities.list });
    },
  });
}

/** Toggle the tenant's customAgentsEnabled flag. */
export function useSetCustomAgentsEnabled(targetOrgId?: string) {
  const { getAuthContext, orgId } = useBBContext();
  const scope = targetOrgId ?? orgId;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      setCustomAgentsEnabled(getAuthContext(), enabled, targetOrgId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bbKeys(scope).tenant.config });
    },
  });
}

// ── conversations ───────────────────────────────────────────────────────────────────

export function useCreateConversation() {
  const { getAuthContext, orgId } = useBBContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, name }: { botId: string; name?: string }) =>
      createConversation(getAuthContext(), botId, name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bbKeys(orgId).conversations.all });
    },
  });
}

/**
 * Delete a conversation. In addition to dropping the React Query caches, this
 * purges the SDK's HIDDEN module-level `convoDetailCache` routing entry — without
 * that, `sendMessage` could keep routing on the deleted conversation's agent.
 */
export function useDeleteConversation() {
  const { getAuthContext, orgId } = useBBContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (convoId: string) => deleteConversation(getAuthContext(), convoId),
    onSuccess: (_data, convoId) => {
      invalidateConvoDetailCache(convoId);
      qc.removeQueries({ queryKey: bbKeys(orgId).conversations.detail(convoId) });
      qc.removeQueries({ queryKey: bbKeys(orgId).messages.forConvo(convoId) });
    },
  });
}

export function useUpdateConversation() {
  const { getAuthContext, orgId } = useBBContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ convoId, patch }: { convoId: string; patch: UpdateConversationPatch }) =>
      updateConversation(getAuthContext(), convoId, patch),
    onSuccess: (_data, { convoId, patch }) => {
      void qc.invalidateQueries({ queryKey: bbKeys(orgId).conversations.detail(convoId) });
      const touchedWebSearch =
        patch.enableWebSearch !== undefined ||
        patch.webSearchType !== undefined ||
        patch.webSearchConfig !== undefined;
      if (touchedWebSearch) {
        void qc.invalidateQueries({ queryKey: bbKeys(orgId).conversations.websearch(convoId) });
      }
    },
  });
}

// ── notes ─────────────────────────────────────────────────────────────────────────

export function useCreateNote() {
  const { getAuthContext, orgId } = useBBContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: CreateNoteParams) => createNote(getAuthContext(), params),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bbKeys(orgId).notes.all });
    },
  });
}
