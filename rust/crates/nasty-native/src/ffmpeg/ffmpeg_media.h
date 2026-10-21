#ifndef SWEET_FFMPEG_MEDIA_H
#define SWEET_FFMPEG_MEDIA_H

#include <stddef.h>

/* File playback through the FFmpeg libraries mpv is linked to.
 * One SweetMedia is either a video decoder or an audio decoder. */

typedef struct SweetMedia SweetMedia;

typedef struct SweetProbe {
    double duration; /* seconds, or < 0 when the container has no duration */
    int width;
    int height;
    int has_audio;
    double frame_rate;
} SweetProbe;

typedef struct SweetVideoFrame {
    const unsigned char *rgba;
    int width;
    int height;
    int stride;
    double pts;
} SweetVideoFrame;

typedef struct SweetAudioChunk {
    const float *samples; /* interleaved */
    int frames;           /* samples per channel */
    int channels;
    int rate;
    double pts;
} SweetAudioChunk;

int sweet_ffmpeg_probe(const char *path, SweetProbe *out, char *err, size_t err_len);

/* want_video and want_audio are 0 or 1. Returns NULL and writes err on failure.
 * Audio-only open writes "no audio stream" when the file has none. */
SweetMedia *sweet_ffmpeg_open(const char *path, int want_video, int want_audio, char *err, size_t err_len);
void sweet_ffmpeg_close(SweetMedia *media);
double sweet_ffmpeg_duration(const SweetMedia *media);
int sweet_ffmpeg_seek(SweetMedia *media, double seconds, char *err, size_t err_len);

/* 1 = a frame, 0 = end of stream, -1 = error. The returned pointers are valid
 * until the next call on this media or sweet_ffmpeg_close.
 * pull leaves the decoded frame held and does not convert it. export converts
 * the held frame to RGBA. discard drops it. next_video does both. */
int sweet_ffmpeg_pull_video(SweetMedia *media, SweetVideoFrame *out, char *err, size_t err_len);
int sweet_ffmpeg_export_video(SweetMedia *media, int max_edge, SweetVideoFrame *out, char *err, size_t err_len);
void sweet_ffmpeg_discard_video(SweetMedia *media);
int sweet_ffmpeg_next_video(SweetMedia *media, int max_edge, SweetVideoFrame *out, char *err, size_t err_len);
int sweet_ffmpeg_next_audio(SweetMedia *media, SweetAudioChunk *out, char *err, size_t err_len);
int sweet_ffmpeg_audio_rate(const SweetMedia *media);
int sweet_ffmpeg_audio_channels(const SweetMedia *media);

#endif
