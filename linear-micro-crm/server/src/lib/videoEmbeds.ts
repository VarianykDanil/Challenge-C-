/**
 * Release 1.3 — OWNED BY P5 learning-videos (laid down by r3-foundation). The outside origins a learning video link may
 * be embedded from (an <iframe>) and its thumbnails loaded from. app.ts adds them to the Content-Security-Policy's
 * frame-src and img-src, so P5 changes this list here, never app.ts. Keep it to the three providers the lead decided:
 * YouTube, Vimeo, Google Drive.
 */
export const VIDEO_EMBED_ORIGINS: readonly string[] = [
  'https://www.youtube-nocookie.com',
  'https://www.youtube.com',
  'https://player.vimeo.com',
  'https://drive.google.com',
];

export const VIDEO_THUMBNAIL_ORIGINS: readonly string[] = ['https://i.ytimg.com', 'https://i.vimeocdn.com'];
