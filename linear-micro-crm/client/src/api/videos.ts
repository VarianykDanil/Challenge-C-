// Release 1.3 — P5 learning-videos hooks — OWNED BY P5 (laid down by r3-foundation). Endpoints: server/src/routes/videos.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LearningVideo,
  TeamVideoProgress,
  VideoAccess,
  VideoAudience,
  VideoLinkInput,
  VideoProgress,
  VideoProgressInput,
  VideoSettings,
  VideoTopic,
  VideoUpdateInput,
  VideoViewRow,
} from '@lm/shared';
import { ApiError, NetworkError, api, qs } from './client';

export const videoKeys = {
  all: ['videos'] as const,
  list: ['videos', 'list'] as const,
  one: (id: number) => ['videos', 'one', id] as const,
  views: (id: number) => ['videos', 'views', id] as const,
  team: (userId?: number | null) => ['videos', 'team', userId ?? null] as const,
  settings: ['videos', 'settings'] as const,
  access: ['videos', 'access'] as const,
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

/** May the signed-in person add videos (admins; leaders when Settings → Learning videos allows it)? */
export function useVideoAccess({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: videoKeys.access, queryFn: () => api<VideoAccess>('/videos/access'), enabled, staleTime: 60_000 });
}

/** The <video> source for an upload (auth by the session cookie; HTTP Range). */
export const videoStreamUrl = (id: number) => `/api/videos/${id}/stream`;

export function useAddVideoLink() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: VideoLinkInput) => api<LearningVideo>('/videos', { method: 'POST', json: input }), onSuccess: () => invalidateVideos(qc) });
}

export interface VideoUploadInput {
  file: File;
  title: string;
  description: string;
  topic: VideoTopic;
  audience: VideoAudience;
  required: boolean;
  /** Read from the file by the browser (the server reads an MP4 / MOV's own length first). */
  durationS: number | null;
  /** A still taken from the file (JPEG), when the browser could take one. */
  poster: Blob | null;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

/**
 * POST /videos/upload as multipart: the fields, the still, then the file (the order the server reads them in). XHR
 * rather than fetch, for the upload progress bar; `signal` cancels it.
 */
export function uploadVideo(input: VideoUploadInput, onProgress: (p: UploadProgress) => void, signal?: AbortSignal): Promise<LearningVideo> {
  const form = new FormData();
  form.append('title', input.title);
  form.append('description', input.description);
  form.append('topic', input.topic);
  form.append('audience', input.audience);
  form.append('required', input.required ? 'true' : 'false');
  if (input.durationS) form.append('durationS', String(Math.round(input.durationS)));
  if (input.poster) form.append('poster', input.poster, 'poster.jpg');
  form.append('video', input.file, input.file.name);
  return new Promise<LearningVideo>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos/upload');
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => onProgress({ loaded: e.loaded, total: e.lengthComputable ? e.total : input.file.size });
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status === 201) resolve(body as LearningVideo);
      else reject(new ApiError(xhr.status, (body as { error: string } | null) ?? { error: `Upload failed (${xhr.status})` }));
    };
    xhr.onerror = () => reject(new NetworkError());
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

export function useUploadVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, onProgress, signal }: { input: VideoUploadInput; onProgress: (p: UploadProgress) => void; signal?: AbortSignal }) => uploadVideo(input, onProgress, signal),
    onSuccess: () => invalidateVideos(qc),
  });
}

/**
 * POST /videos/:id/poster — an upload's still (a JPEG data URL) and, when it has none, its length: taken by an editor's
 * browser from the server's copy the first time it opens the video (features/videos/useVideoStill.ts).
 */
export function useSaveVideoStill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, image, durationS }: { id: number; image: string; durationS?: number }) =>
      api<LearningVideo>(`/videos/${id}/poster`, { method: 'POST', json: durationS ? { image, durationS } : { image } }),
    onSuccess: (v) => {
      qc.setQueryData<LearningVideo>(videoKeys.one(v.id), (old) => (old ? { ...v, my: old.my } : v));
      void qc.invalidateQueries({ queryKey: videoKeys.list });
    },
  });
}

export function useUpdateVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VideoUpdateInput & { id: number }) => api<LearningVideo>(`/videos/${id}`, { method: 'PATCH', json: input }),
    onSuccess: (v) => {
      qc.setQueryData(videoKeys.one(v.id), v);
      invalidateVideos(qc);
    },
  });
}

export function useDeleteVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/videos/${id}`, { method: 'DELETE' }),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: videoKeys.one(id) });
      invalidateVideos(qc);
    },
  });
}

/**
 * POST /videos/:id/progress — every 15 s and on pause / end. Keeps the video's own `my` up to date without refetching;
 * the list and the checklists refresh only when it becomes watched (no invalidation storm while it plays).
 */
export function useReportVideoProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: VideoProgressInput & { id: number }) => api<VideoProgress>(`/videos/${id}/progress`, { method: 'POST', json: input }),
    onSuccess: (p, v) => {
      const before = qc.getQueryData<LearningVideo>(videoKeys.one(v.id));
      qc.setQueryData<LearningVideo>(videoKeys.one(v.id), (old) => (old ? { ...old, my: p } : old));
      qc.setQueryData<LearningVideo[]>(videoKeys.list, (old) => old?.map((x) => (x.id === v.id ? { ...x, my: p } : x)));
      if (p.completedAt && !before?.my?.completedAt) {
        void qc.invalidateQueries({ queryKey: videoKeys.list });
        void qc.invalidateQueries({ queryKey: ['videos', 'team'] });
      }
    },
  });
}

/** The last report as the page goes away (tab closed, phone locked): sent with keepalive, never awaited. */
export function sendVideoProgressBeacon(id: number, input: VideoProgressInput): void {
  try {
    void fetch(`/api/videos/${id}/progress`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).catch(() => undefined);
  } catch {
    /* the page is going: nothing to do */
  }
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
  return useMutation({
    mutationFn: (input: Pick<VideoSettings, 'leadersCanAdd'>) => api<VideoSettings>('/videos/settings', { method: 'PUT', json: input }),
    onSuccess: (s) => {
      qc.setQueryData(videoKeys.settings, s);
      invalidateVideos(qc);
    },
  });
}
