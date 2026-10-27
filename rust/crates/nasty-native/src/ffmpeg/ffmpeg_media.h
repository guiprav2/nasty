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
/* Decode-and-drop one picture with AVDISCARD_NONREF so catch-up is cheaper than
 * full reconstruct+sws. Returns 1/0/-1 like pull_video; out only gets pts/size. */
int sweet_ffmpeg_skip_video(SweetMedia *media, SweetVideoFrame *out, char *err, size_t err_len);
int sweet_ffmpeg_next_video(SweetMedia *media, int max_edge, SweetVideoFrame *out, char *err, size_t err_len);
int sweet_ffmpeg_next_audio(SweetMedia *media, SweetAudioChunk *out, char *err, size_t err_len);
int sweet_ffmpeg_audio_rate(const SweetMedia *media);
int sweet_ffmpeg_audio_channels(const SweetMedia *media);

/* Compressed-AU (packet) video decode. No AVFormatContext — JS/mp4-stream demuxes.
 * codec: "h264" | "hevc" | "av1"
 * extradata: Annex-B param sets for h264/hevc, or AV1 config OBU bytes from mp4-stream.
 * Prefer VAAPI then software (same pattern as file open_decoder). */
typedef struct SweetPacketVideo SweetPacketVideo;

SweetPacketVideo *sweet_ffmpeg_open_packet_video(
    const char *codec,
    const unsigned char *extradata, size_t extradata_len,
    char *err, size_t err_len);

void sweet_ffmpeg_close_packet_video(SweetPacketVideo *dec);

/* Send one compressed AU. pts_seconds is media time. keyframe nonzero for sync samples.
 * Returns 0 ok, -1 error. */
int sweet_ffmpeg_packet_send(
    SweetPacketVideo *dec,
    const unsigned char *data, size_t len,
    double pts_seconds, int keyframe,
    char *err, size_t err_len);

/* Decode next picture into held without converting. 1 = frame, 0 = need more input, -1 = error.
 * out gets pts/size; rgba is null until export/receive_rgba. */
int sweet_ffmpeg_packet_pull(SweetPacketVideo *dec, SweetVideoFrame *out, char *err, size_t err_len);

/* Convert the held frame to RGBA. max_edge 0 = full size. Clears held. */
int sweet_ffmpeg_packet_export(SweetPacketVideo *dec, int max_edge, SweetVideoFrame *out, char *err, size_t err_len);

/* Try receive+export one RGBA frame. max_edge 0 = full size.
 * Returns 1 frame, 0 need more input, -1 error.
 * out->rgba valid until next receive/close/send that exports. */
int sweet_ffmpeg_packet_receive_rgba(
    SweetPacketVideo *dec, int max_edge,
    SweetVideoFrame *out, char *err, size_t err_len);

/* Discard held decoded frame without sws (for late frames). */
void sweet_ffmpeg_packet_discard(SweetPacketVideo *dec);

/* Flush: send NULL packet; then receive until 0. */
int sweet_ffmpeg_packet_flush(SweetPacketVideo *dec, char *err, size_t err_len);

#endif
