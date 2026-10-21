// Release 1.3 — P5 learning-videos hooks — OWNED BY P5 (laid down by r3-foundation). Endpoints: server/src/routes/videos.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LearningVideo, TeamVideoProgress, VideoLinkInput, VideoProgress, VideoProgressInput, VideoSettings, VideoUpdateInput, VideoViewRow } from '@lm/shared';
import { api, qs } from './client';

export const videoKeys = {
  all: ['videos'] as const,
  list: ['videos', 'list'] as const,
  one: (id: number) => ['videos', 'one', id] as const,
  views: (id: number) => ['videos', 'views', id] as const,
  team: (userId?: number | null) => ['videos', 'team', userId ?? null] as const,
  settings: ['videos', 'settings'] as const,
};

const invalidateVideos = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: videoKeys.all });
  void qc.invalidateQueries({ queryKey: ['learning'] });
};

export function useVideos({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: videoKeys.list, queryFn: () => api<LearningVideo[]>('/videos'), enabled });
}

export function useVideo(id: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: videoKeys.one(id ?? 0), queryFn: () => api<LearningVideo>(`/videos/${id}`), enabled: enabled && id != null });
}

/** The <video> source for an upload (auth by the session cookie; HTTP Range). */
export const videoStreamUrl = (id: number) => `/api/videos/${id}/stream`;

export function useAddVideoLink() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: VideoLinkInput) => api<LearningVideo>('/videos', { method: 'POST', json: input }), onSuccess: () => invalidateVideos(qc) });
}

export function useUpdateVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VideoUpdateInput & { id: number }) => api<LearningVideo>(`/videos/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => invalidateVideos(qc),
  });
}

export function useDeleteVideo() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => api<void>(`/videos/${id}`, { method: 'DELETE' }), onSuccess: () => invalidateVideos(qc) });
}

/** POST /videos/:id/progress — every 15 s and on pause / end; no invalidation storm (only the video itself). */
export function useReportVideoProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VideoProgressInput & { id: number }) => api<VideoProgress>(`/videos/${id}/progress`, { method: 'POST', json: input }),
    onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: videoKeys.one(v.id) }),
  });
}

export function useVideoViews(id: number | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: videoKeys.views(id ?? 0), queryFn: () => api<VideoViewRow[]>(`/videos/${id}/views`), enabled: enabled && id != null });
}

export function useTeamVideoProgress(userId?: number | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: videoKeys.team(userId), queryFn: () => api<TeamVideoProgress>(`/videos/team${qs({ userId: userId ?? undefined })}`), enabled });
}

export function useVideoSettings({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: videoKeys.settings, queryFn: () => api<VideoSettings>('/videos/settings'), enabled });
}

export function useSaveVideoSettings() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: VideoSettings) => api<VideoSettings>('/videos/settings', { method: 'PUT', json: input }), onSuccess: () => invalidateVideos(qc) });
}
