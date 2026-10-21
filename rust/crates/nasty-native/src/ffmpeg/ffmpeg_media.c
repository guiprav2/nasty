#include "ffmpeg_media.h"

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/display.h>
#include <libavutil/hwcontext.h>
#include <libavutil/mathematics.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

struct SweetMedia {
    AVFormatContext *fmt;
    AVCodecContext *video;
    AVCodecContext *audio;
    int video_index;
    int audio_index;
    AVPacket *packet;
    AVFrame *frame;
    /* System-memory copy of a VA-API surface. Null when decode stays on the CPU. */
    AVFrame *downloaded;
    int packet_pending;
    int held;
    int flush_sent_video;
    int flush_sent_audio;
    int swr_drained;
    struct SwsContext *sws;
    int sws_w, sws_h, sws_fmt, sws_dw, sws_dh, sws_cs, sws_range;
    struct SwrContext *swr;
    int rotation;
    int out_rate;
    int out_channels;
    double duration;
    unsigned char *rgba;
    int rgba_cap;
    unsigned char *scratch;
    int scratch_cap;
    float *pcm;
    int pcm_cap;
};

static void set_err(char *err, size_t len, const char *msg) {
    if (!err || len == 0) {
        return;
    }
    snprintf(err, len, "%s", msg ? msg : "unknown error");
}

static void set_averr(char *err, size_t len, const char *what, int code) {
    char detail[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(code, detail, sizeof detail);
    if (!err || len == 0) {
        return;
    }
    snprintf(err, len, "%s: %s", what, detail);
}

static int snap_rotation(double raw) {
    int angle;
    if (raw != raw) {
        return 0;
    }
    angle = (int)(raw < 0 ? raw - 0.5 : raw + 0.5);
    angle %= 360;
    if (angle < 0) {
        angle += 360;
    }
    if (angle > 45 && angle < 135) {
        return 90;
    }
    if (angle >= 135 && angle < 225) {
        return 180;
    }
    if (angle >= 225 && angle < 315) {
        return 270;
    }
    return 0;
}

static int matrix_rotation(const int32_t *matrix) {
    if (!matrix) {
        return 0;
    }
    return snap_rotation(av_display_rotation_get(matrix));
}

static int stream_rotation(const AVStream *stream) {
    int32_t *matrix = (int32_t *)av_stream_get_side_data(stream, AV_PKT_DATA_DISPLAYMATRIX, NULL);
    return matrix_rotation(matrix);
}

static int frame_rotation(const AVFrame *frame, int fallback) {
    AVFrameSideData *side = av_frame_get_side_data(frame, AV_FRAME_DATA_DISPLAYMATRIX);
    if (!side || side->size < (int)(9 * sizeof(int32_t))) {
        return fallback;
    }
    return matrix_rotation((const int32_t *)side->data);
}

/* Fit the upright picture into max_edge and report the pre-rotation size
 * that swscale should produce. SAR is applied before rotation. */
static void upright_size(int coded_w, int coded_h, AVRational sar, int rotation, int max_edge,
                         int *out_w, int *out_h, int *pre_w, int *pre_h) {
    int w = coded_w;
    int h = coded_h;
    int uw, uh;
    if (sar.num > 0 && sar.den > 0 && sar.num != sar.den) {
        if (sar.num > sar.den) {
            int64_t scaled = av_rescale(w, sar.num, sar.den);
            if (scaled < 1) {
                scaled = 1;
            }
            if (scaled > 16384) {
                scaled = 16384;
            }
            w = (int)scaled;
        } else {
            int64_t scaled = av_rescale(h, sar.den, sar.num);
            if (scaled < 1) {
                scaled = 1;
            }
            if (scaled > 16384) {
                scaled = 16384;
            }
            h = (int)scaled;
        }
    }
    uw = w;
    uh = h;
    if (rotation == 90 || rotation == 270) {
        uw = h;
        uh = w;
    }
    if (max_edge > 0 && uw > 0 && uh > 0) {
        int edge = uw > uh ? uw : uh;
        if (edge > max_edge) {
            double scale = (double)max_edge / (double)edge;
            int nw = (int)((double)uw * scale + 0.5);
            int nh = (int)((double)uh * scale + 0.5);
            if (nw < 1) {
                nw = 1;
            }
            if (nh < 1) {
                nh = 1;
            }
            if (nw > max_edge) {
                nw = max_edge;
            }
            if (nh > max_edge) {
                nh = max_edge;
            }
            uw = nw;
            uh = nh;
        }
    }
    *out_w = uw;
    *out_h = uh;
    if (rotation == 90 || rotation == 270) {
        *pre_w = uh;
        *pre_h = uw;
    } else {
        *pre_w = uw;
        *pre_h = uh;
    }
}

static int colorspace_of(const AVFrame *frame) {
    switch (frame->colorspace) {
    case AVCOL_SPC_BT470BG:
    case AVCOL_SPC_SMPTE170M:
        return SWS_CS_ITU601;
    case AVCOL_SPC_SMPTE240M:
        return SWS_CS_SMPTE240M;
    case AVCOL_SPC_BT2020_NCL:
    case AVCOL_SPC_BT2020_CL:
        return SWS_CS_BT2020;
    case AVCOL_SPC_FCC:
        return SWS_CS_FCC;
    case AVCOL_SPC_UNSPECIFIED:
        if (frame->height > 0 && frame->height < 720) {
            return SWS_CS_ITU601;
        }
        return SWS_CS_ITU709;
    default:
        return SWS_CS_ITU709;
    }
}

static int full_range(const AVFrame *frame) {
    const AVPixFmtDescriptor *desc;
    if (frame->color_range == AVCOL_RANGE_JPEG) {
        return 1;
    }
    if (frame->color_range == AVCOL_RANGE_MPEG) {
        return 0;
    }
    switch ((enum AVPixelFormat)frame->format) {
    case AV_PIX_FMT_YUVJ420P:
    case AV_PIX_FMT_YUVJ422P:
    case AV_PIX_FMT_YUVJ444P:
    case AV_PIX_FMT_YUVJ440P:
    case AV_PIX_FMT_YUVJ411P:
        return 1;
    default:
        break;
    }
    desc = av_pix_fmt_desc_get((enum AVPixelFormat)frame->format);
    if (desc && (desc->flags & AV_PIX_FMT_FLAG_RGB)) {
        return 1;
    }
    return 0;
}

static int ensure_bytes(unsigned char **buf, int *cap, int need, char *err, size_t err_len) {
    unsigned char *next;
    if (need < 0) {
        set_err(err, err_len, "frame size overflow");
        return -1;
    }
    if (*cap >= need) {
        return 0;
    }
    next = realloc(*buf, (size_t)need);
    if (!next) {
        set_err(err, err_len, "out of memory");
        return -1;
    }
    *buf = next;
    *cap = need;
    return 0;
}

static int ensure_floats(float **buf, int *cap, int count, char *err, size_t err_len) {
    float *next;
    if (count < 0) {
        set_err(err, err_len, "audio size overflow");
        return -1;
    }
    if (*cap >= count) {
        return 0;
    }
    next = realloc(*buf, (size_t)count * sizeof(float));
    if (!next) {
        set_err(err, err_len, "out of memory");
        return -1;
    }
    *buf = next;
    *cap = count;
    return 0;
}

static void rotate_rgba(const unsigned char *src, int src_stride, int w, int h, int ccw,
                        unsigned char *dst, int dst_stride) {
    int x, y;
    if (ccw == 0) {
        for (y = 0; y < h; y++) {
            memcpy(dst + (size_t)y * dst_stride, src + (size_t)y * src_stride, (size_t)w * 4);
        }
        return;
    }
    if (ccw == 180) {
        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                memcpy(dst + (size_t)(h - 1 - y) * dst_stride + (size_t)(w - 1 - x) * 4,
                       src + (size_t)y * src_stride + (size_t)x * 4, 4);
            }
        }
        return;
    }
    if (ccw == 90) {
        for (y = 0; y < w; y++) {
            unsigned char *row = dst + (size_t)y * dst_stride;
            for (x = 0; x < h; x++) {
                int sx = w - 1 - y;
                int sy = x;
                memcpy(row + (size_t)x * 4, src + (size_t)sy * src_stride + (size_t)sx * 4, 4);
            }
        }
        return;
    }
    for (y = 0; y < w; y++) {
        unsigned char *row = dst + (size_t)y * dst_stride;
        for (x = 0; x < h; x++) {
            int sx = y;
            int sy = h - 1 - x;
            memcpy(row + (size_t)x * 4, src + (size_t)sy * src_stride + (size_t)sx * 4, 4);
        }
    }
}

static int ensure_sws(SweetMedia *media, const AVFrame *frame, int dst_w, int dst_h, int cs, int range,
                      char *err, size_t err_len) {
    const int *coeffs;
    if (media->sws && media->sws_w == frame->width && media->sws_h == frame->height &&
        media->sws_fmt == frame->format && media->sws_dw == dst_w && media->sws_dh == dst_h &&
        media->sws_cs == cs && media->sws_range == range) {
        return 0;
    }
    sws_freeContext(media->sws);
    /* Fast bilinear, not Lanczos. Lanczos on the CPU cannot keep a 2160p or
     * 1080p60 frame on time, and it was just as slow when scaling a 2160p
     * frame down to a grid cell. The window scales this texture on the GPU.
     * The matrix below is what keeps the colors matched to the stream. */
    media->sws = sws_getContext(frame->width, frame->height, (enum AVPixelFormat)frame->format, dst_w, dst_h,
                                AV_PIX_FMT_RGBA, SWS_FAST_BILINEAR, NULL, NULL, NULL);
    if (!media->sws) {
        set_err(err, err_len, "swscale cannot convert this frame");
        return -1;
    }
    coeffs = sws_getCoefficients(cs);
    /* RGB sources have no YUV matrix. A rejected details call still leaves a usable converter. */
    sws_setColorspaceDetails(media->sws, coeffs, range, coeffs, 1, 0, 1 << 16, 1 << 16);
    media->sws_w = frame->width;
    media->sws_h = frame->height;
    media->sws_fmt = frame->format;
    media->sws_dw = dst_w;
    media->sws_dh = dst_h;
    media->sws_cs = cs;
    media->sws_range = range;
    return 0;
}

static double frame_pts(const AVFrame *frame, const AVStream *stream) {
    int64_t pts = frame->best_effort_timestamp;
    if (pts == AV_NOPTS_VALUE) {
        pts = frame->pts;
    }
    if (pts == AV_NOPTS_VALUE || !stream) {
        return 0.0;
    }
    return pts * av_q2d(stream->time_base);
}

/* VA-API surfaces cannot be scaled in place. Download to NV12 (or P010) first. */
static AVFrame *software_frame(SweetMedia *media, AVFrame *frame, char *err, size_t err_len) {
    int ret;
    if (frame->format != AV_PIX_FMT_VAAPI) {
        return frame;
    }
    if (!media->downloaded) {
        media->downloaded = av_frame_alloc();
        if (!media->downloaded) {
            set_err(err, err_len, "out of memory");
            return NULL;
        }
    }
    av_frame_unref(media->downloaded);
    ret = av_hwframe_transfer_data(media->downloaded, frame, 0);
    if (ret < 0) {
        set_averr(err, err_len, "reading a hardware frame", ret);
        return NULL;
    }
    if (media->downloaded->color_range == AVCOL_RANGE_UNSPECIFIED) {
        media->downloaded->color_range = frame->color_range;
    }
    if (media->downloaded->colorspace == AVCOL_SPC_UNSPECIFIED) {
        media->downloaded->colorspace = frame->colorspace;
    }
    media->downloaded->pts = frame->pts;
    media->downloaded->best_effort_timestamp = frame->best_effort_timestamp;
    if (media->downloaded->sample_aspect_ratio.num <= 0) {
        media->downloaded->sample_aspect_ratio = frame->sample_aspect_ratio;
    }
    return media->downloaded;
}

static int emit_video(SweetMedia *media, int max_edge, SweetVideoFrame *out, char *err, size_t err_len) {
    AVFrame *hw = media->frame;
    AVFrame *frame;
    AVRational sar;
    int rotation, out_w, out_h, pre_w, pre_h, cs, range, pre_stride, out_stride;
    unsigned char *scaled;
    const uint8_t *src_slices[4];
    int src_strides[4];
    uint8_t *dst_slices[4];
    int dst_strides[4];
    if (!hw || hw->width <= 0 || hw->height <= 0) {
        return 0;
    }
    sar = hw->sample_aspect_ratio;
    if (sar.num <= 0 || sar.den <= 0) {
        sar = media->fmt->streams[media->video_index]->codecpar->sample_aspect_ratio;
    }
    rotation = frame_rotation(hw, media->rotation);
    frame = software_frame(media, hw, err, err_len);
    if (!frame) {
        return -1;
    }
    upright_size(frame->width, frame->height, sar, rotation, max_edge, &out_w, &out_h, &pre_w, &pre_h);
    if (out_w <= 0 || out_h <= 0 || pre_w <= 0 || pre_h <= 0) {
        return 0;
    }
    cs = colorspace_of(frame);
    range = full_range(frame);
    if (ensure_sws(media, frame, pre_w, pre_h, cs, range, err, err_len) < 0) {
        return -1;
    }
    pre_stride = pre_w * 4;
    out_stride = out_w * 4;
    if (pre_stride / 4 != pre_w || out_stride / 4 != out_w) {
        set_err(err, err_len, "frame size overflow");
        return -1;
    }
    if (ensure_bytes(&media->rgba, &media->rgba_cap, out_stride * out_h, err, err_len) < 0) {
        return -1;
    }
    if (rotation == 0) {
        scaled = media->rgba;
    } else {
        if (ensure_bytes(&media->scratch, &media->scratch_cap, pre_stride * pre_h, err, err_len) < 0) {
            return -1;
        }
        scaled = media->scratch;
    }
    src_slices[0] = frame->data[0];
    src_slices[1] = frame->data[1];
    src_slices[2] = frame->data[2];
    src_slices[3] = frame->data[3];
    src_strides[0] = frame->linesize[0];
    src_strides[1] = frame->linesize[1];
    src_strides[2] = frame->linesize[2];
    src_strides[3] = frame->linesize[3];
    dst_slices[0] = scaled;
    dst_slices[1] = NULL;
    dst_slices[2] = NULL;
    dst_slices[3] = NULL;
    dst_strides[0] = pre_stride;
    dst_strides[1] = 0;
    dst_strides[2] = 0;
    dst_strides[3] = 0;
    if (sws_scale(media->sws, src_slices, src_strides, 0, frame->height, dst_slices, dst_strides) <= 0) {
        set_err(err, err_len, "swscale produced no rows");
        return -1;
    }
    if (rotation != 0) {
        rotate_rgba(scaled, pre_stride, pre_w, pre_h, rotation, media->rgba, out_stride);
    }
    out->rgba = media->rgba;
    out->width = out_w;
    out->height = out_h;
    out->stride = out_stride;
    out->pts = frame_pts(frame, media->fmt->streams[media->video_index]);
    return 1;
}

static void keep_only(AVFormatContext *fmt, int index) {
    unsigned i;
    for (i = 0; i < fmt->nb_streams; i++) {
        if ((int)i != index) {
            fmt->streams[i]->discard = AVDISCARD_ALL;
        }
    }
}

/* NULL does not find the render node on this machine. Try the DRM nodes. */
static AVBufferRef *open_vaapi_device(void) {
    int index;
    for (index = 128; index < 136; index++) {
        char path[64];
        AVBufferRef *device = NULL;
        snprintf(path, sizeof path, "/dev/dri/renderD%d", index);
        if (av_hwdevice_ctx_create(&device, AV_HWDEVICE_TYPE_VAAPI, path, NULL, 0) == 0) {
            return device;
        }
    }
    return NULL;
}

/* Prefer a VA-API surface when the driver offers one. Otherwise keep software. */
static enum AVPixelFormat choose_video_format(AVCodecContext *ctx, const enum AVPixelFormat *fmts) {
    const enum AVPixelFormat *fmt;
    (void)ctx;
    for (fmt = fmts; *fmt != AV_PIX_FMT_NONE; fmt++) {
        if (*fmt == AV_PIX_FMT_VAAPI) {
            return *fmt;
        }
    }
    return fmts[0];
}

static int open_decoder(AVFormatContext *fmt, int index, AVCodec *codec, int video, AVCodecContext **out,
                        char *err, size_t err_len) {
    int attempt;
    if (!codec) {
        codec = avcodec_find_decoder(fmt->streams[index]->codecpar->codec_id);
    }
    if (!codec) {
        set_err(err, err_len, video ? "unsupported video codec" : "unsupported audio codec");
        return -1;
    }
    /* attempt 0 tries VA-API. attempt 1 is the CPU decoder if the driver or the
     * codec refuses the hardware path. */
    for (attempt = 0; attempt < (video ? 2 : 1); attempt++) {
        AVCodecContext *ctx = avcodec_alloc_context3(codec);
        int use_hw = video && attempt == 0;
        int ret;
        int cpus;
        if (!ctx) {
            set_err(err, err_len, "out of memory");
            return -1;
        }
        ret = avcodec_parameters_to_context(ctx, fmt->streams[index]->codecpar);
        if (ret < 0) {
            avcodec_free_context(&ctx);
            set_averr(err, err_len, "codec parameters", ret);
            return -1;
        }
        ctx->pkt_timebase = fmt->streams[index]->time_base;
        if (video) {
            cpus = (int)sysconf(_SC_NPROCESSORS_ONLN);
            if (cpus < 1) {
                cpus = 1;
            }
            /* A grid plays many files at once, so don't take every core per clip. */
            ctx->thread_count = cpus > 4 ? 2 : cpus;
            ctx->thread_type = FF_THREAD_FRAME;
            if (use_hw) {
                AVBufferRef *device = open_vaapi_device();
                if (!device) {
                    avcodec_free_context(&ctx);
                    continue;
                }
                ctx->hw_device_ctx = device;
                ctx->get_format = choose_video_format;
                ctx->extra_hw_frames = 16;
                ctx->thread_count = 1;
            }
        }
        ret = avcodec_open2(ctx, codec, NULL);
        if (ret == 0) {
            *out = ctx;
            return 0;
        }
        avcodec_free_context(&ctx);
        if (!use_hw) {
            set_averr(err, err_len, "opening decoder", ret);
            return -1;
        }
    }
    set_err(err, err_len, "opening decoder");
    return -1;
}

static int ensure_swr(SweetMedia *media, char *err, size_t err_len) {
    int64_t layout;
    int channels;
    int out_channels;
    int64_t out_layout;
    if (media->swr) {
        return 0;
    }
    if (!media->audio) {
        set_err(err, err_len, "no audio stream");
        return -1;
    }
    layout = media->audio->channel_layout;
    channels = media->audio->channels;
    if (layout == 0 && channels > 0) {
        layout = av_get_default_channel_layout(channels);
    }
    if (channels <= 0) {
        channels = av_get_channel_layout_nb_channels((uint64_t)layout);
    }
    if (channels <= 0 || media->audio->sample_rate <= 0) {
        set_err(err, err_len, "audio stream has no rate or channel count");
        return -1;
    }
    out_channels = channels >= 2 ? 2 : 1;
    out_layout = out_channels == 1 ? AV_CH_LAYOUT_MONO : AV_CH_LAYOUT_STEREO;
    if (channels == out_channels && layout != 0) {
        out_layout = layout;
    }
    media->swr = swr_alloc_set_opts(NULL, out_layout, AV_SAMPLE_FMT_FLT, media->audio->sample_rate, layout,
                                    media->audio->sample_fmt, media->audio->sample_rate, 0, NULL);
    if (!media->swr || swr_init(media->swr) < 0) {
        set_err(err, err_len, "audio resampler failed");
        return -1;
    }
    media->out_rate = media->audio->sample_rate;
    media->out_channels = out_channels;
    return 0;
}

static int open_input(const char *path, AVFormatContext **fmt, char *err, size_t err_len) {
    int ret = avformat_open_input(fmt, path, NULL, NULL);
    if (ret < 0) {
        set_averr(err, err_len, "opening media", ret);
        return -1;
    }
    (*fmt)->flags |= AVFMT_FLAG_GENPTS;
    ret = avformat_find_stream_info(*fmt, NULL);
    if (ret < 0) {
        set_averr(err, err_len, "reading stream info", ret);
        return -1;
    }
    return 0;
}

int sweet_ffmpeg_probe(const char *path, SweetProbe *out, char *err, size_t err_len) {
    AVFormatContext *fmt = NULL;
    AVCodec *codec = NULL;
    int video;
    int audio;
    int width = 0;
    int height = 0;
    int pre_w = 0;
    int pre_h = 0;
    AVRational sar = {0, 1};
    if (!out) {
        set_err(err, err_len, "missing probe output");
        return -1;
    }
    memset(out, 0, sizeof *out);
    out->duration = -1;
    av_log_set_level(AV_LOG_ERROR);
    if (open_input(path, &fmt, err, err_len) < 0) {
        avformat_close_input(&fmt);
        return -1;
    }
    if (fmt->duration > 0) {
        out->duration = (double)fmt->duration / (double)AV_TIME_BASE;
    }
    video = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &codec, 0);
    audio = av_find_best_stream(fmt, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    out->has_audio = audio >= 0;
    if (video < 0) {
        avformat_close_input(&fmt);
        set_err(err, err_len, "no video stream");
        return -1;
    }
    sar = fmt->streams[video]->codecpar->sample_aspect_ratio;
    AVRational frame_rate = fmt->streams[video]->avg_frame_rate;
    if (frame_rate.num <= 0 || frame_rate.den <= 0) frame_rate = fmt->streams[video]->r_frame_rate;
    out->frame_rate = frame_rate.num > 0 && frame_rate.den > 0 ? av_q2d(frame_rate) : 30.0;
    upright_size(fmt->streams[video]->codecpar->width, fmt->streams[video]->codecpar->height, sar,
                 stream_rotation(fmt->streams[video]), 0, &width, &height, &pre_w, &pre_h);
    out->width = width;
    out->height = height;
    avformat_close_input(&fmt);
    return 0;
}

SweetMedia *sweet_ffmpeg_open(const char *path, int want_video, int want_audio, char *err, size_t err_len) {
    SweetMedia *media = calloc(1, sizeof *media);
    AVCodec *video_codec = NULL;
    AVCodec *audio_codec = NULL;
    if (!media) {
        set_err(err, err_len, "out of memory");
        return NULL;
    }
    media->video_index = -1;
    media->audio_index = -1;
    av_log_set_level(AV_LOG_ERROR);
    if (!want_video && !want_audio) {
        set_err(err, err_len, "nothing to decode");
        goto fail;
    }
    if (open_input(path, &media->fmt, err, err_len) < 0) {
        goto fail;
    }
    if (media->fmt->duration > 0) {
        media->duration = (double)media->fmt->duration / (double)AV_TIME_BASE;
    }
    if (want_video) {
        media->video_index = av_find_best_stream(media->fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &video_codec, 0);
        if (media->video_index < 0) {
            set_err(err, err_len, "no video stream");
            goto fail;
        }
        media->rotation = stream_rotation(media->fmt->streams[media->video_index]);
        if (open_decoder(media->fmt, media->video_index, video_codec, 1, &media->video, err, err_len) < 0) {
            goto fail;
        }
        if (!want_audio) {
            keep_only(media->fmt, media->video_index);
        }
    }
    if (want_audio) {
        media->audio_index = av_find_best_stream(media->fmt, AVMEDIA_TYPE_AUDIO, -1, -1, &audio_codec, 0);
        if (media->audio_index < 0) {
            set_err(err, err_len, "no audio stream");
            goto fail;
        }
        if (open_decoder(media->fmt, media->audio_index, audio_codec, 0, &media->audio, err, err_len) < 0) {
            goto fail;
        }
        if (ensure_swr(media, err, err_len) < 0) {
            goto fail;
        }
        if (!want_video) {
            keep_only(media->fmt, media->audio_index);
        }
    }
    media->packet = av_packet_alloc();
    media->frame = av_frame_alloc();
    if (!media->packet || !media->frame) {
        set_err(err, err_len, "out of memory");
        goto fail;
    }
    return media;
fail:
    sweet_ffmpeg_close(media);
    return NULL;
}

void sweet_ffmpeg_close(SweetMedia *media) {
    if (!media) {
        return;
    }
    sws_freeContext(media->sws);
    swr_free(&media->swr);
    /* The downloaded surface holds a buffer from the decoder pool. Free it
     * before the codec, or closing the player frees that buffer twice. */
    av_frame_free(&media->downloaded);
    av_frame_free(&media->frame);
    av_packet_free(&media->packet);
    avcodec_free_context(&media->video);
    avcodec_free_context(&media->audio);
    avformat_close_input(&media->fmt);
    free(media->rgba);
    free(media->scratch);
    free(media->pcm);
    free(media);
}

double sweet_ffmpeg_duration(const SweetMedia *media) {
    if (!media || media->duration <= 0) {
        return -1;
    }
    return media->duration;
}

int sweet_ffmpeg_seek(SweetMedia *media, double seconds, char *err, size_t err_len) {
    int64_t ts;
    int ret;
    if (!media || !media->fmt) {
        set_err(err, err_len, "media is closed");
        return -1;
    }
    if (seconds < 0) {
        seconds = 0;
    }
    ts = (int64_t)(seconds * (double)AV_TIME_BASE);
    ret = av_seek_frame(media->fmt, -1, ts, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) {
        set_averr(err, err_len, "seek", ret);
        return -1;
    }
    if (media->held && media->frame) {
        av_frame_unref(media->frame);
    }
    media->held = 0;
    if (media->video) {
        avcodec_flush_buffers(media->video);
    }
    if (media->audio) {
        avcodec_flush_buffers(media->audio);
    }
    if (media->swr) {
        swr_free(&media->swr);
    }
    if (media->packet) {
        av_packet_unref(media->packet);
    }
    media->packet_pending = 0;
    media->flush_sent_video = 0;
    media->flush_sent_audio = 0;
    media->swr_drained = 0;
    return 0;
}

int sweet_ffmpeg_audio_rate(const SweetMedia *media) {
    if (!media || media->out_rate <= 0) {
        return 0;
    }
    return media->out_rate;
}

int sweet_ffmpeg_audio_channels(const SweetMedia *media) {
    if (!media || media->out_channels <= 0) {
        return 0;
    }
    return media->out_channels;
}

static void describe_held(const SweetMedia *media, SweetVideoFrame *out) {
    out->rgba = NULL;
    out->width = media->frame->width;
    out->height = media->frame->height;
    out->stride = 0;
    out->pts = frame_pts(media->frame, media->fmt->streams[media->video_index]);
}

int sweet_ffmpeg_pull_video(SweetMedia *media, SweetVideoFrame *out, char *err, size_t err_len) {
    int spins = 0;
    if (!media || !media->video || !out) {
        set_err(err, err_len, "no video stream");
        return -1;
    }
    if (media->held) {
        describe_held(media, out);
        return 1;
    }
    for (;;) {
        int ret = avcodec_receive_frame(media->video, media->frame);
        if (ret == 0) {
            if (media->frame->width <= 0 || media->frame->height <= 0) {
                av_frame_unref(media->frame);
                continue;
            }
            media->held = 1;
            describe_held(media, out);
            return 1;
        }
        if (ret != AVERROR(EAGAIN)) {
            if (ret == AVERROR_EOF) {
                return 0;
            }
            set_averr(err, err_len, "decoding video", ret);
            return -1;
        }
        if (media->flush_sent_video) {
            return 0;
        }
        if (!media->packet_pending) {
            ret = av_read_frame(media->fmt, media->packet);
            if (ret == AVERROR_EOF) {
                ret = avcodec_send_packet(media->video, NULL);
                media->flush_sent_video = 1;
                if (ret < 0 && ret != AVERROR_EOF) {
                    set_averr(err, err_len, "flushing video", ret);
                    return -1;
                }
                continue;
            }
            if (ret < 0) {
                set_averr(err, err_len, "reading video", ret);
                return -1;
            }
            if (media->packet->stream_index != media->video_index) {
                av_packet_unref(media->packet);
                continue;
            }
            media->packet_pending = 1;
        }
        ret = avcodec_send_packet(media->video, media->packet);
        if (ret == 0) {
            av_packet_unref(media->packet);
            media->packet_pending = 0;
            spins = 0;
            continue;
        }
        if (ret == AVERROR(EAGAIN)) {
            if (++spins > 8) {
                set_err(err, err_len, "video decoder stalled");
                return -1;
            }
            continue;
        }
        set_averr(err, err_len, "decoding video", ret);
        return -1;
    }
}

int sweet_ffmpeg_export_video(SweetMedia *media, int max_edge, SweetVideoFrame *out, char *err, size_t err_len) {
    int produced;
    if (!media || !media->held || !out) {
        set_err(err, err_len, "no video frame");
        return -1;
    }
    produced = emit_video(media, max_edge, out, err, err_len);
    av_frame_unref(media->frame);
    media->held = 0;
    if (produced < 0) {
        return -1;
    }
    return produced == 0 ? 0 : 1;
}

void sweet_ffmpeg_discard_video(SweetMedia *media) {
    if (!media || !media->held) {
        return;
    }
    av_frame_unref(media->frame);
    media->held = 0;
}

int sweet_ffmpeg_next_video(SweetMedia *media, int max_edge, SweetVideoFrame *out, char *err, size_t err_len) {
    int ret = sweet_ffmpeg_pull_video(media, out, err, err_len);
    if (ret != 1) {
        return ret;
    }
    return sweet_ffmpeg_export_video(media, max_edge, out, err, err_len);
}

static int emit_audio(SweetMedia *media, const AVFrame *frame, SweetAudioChunk *out, char *err, size_t err_len) {
    int delay;
    int out_count;
    int got;
    uint8_t *planes[1];
    if (ensure_swr(media, err, err_len) < 0) {
        return -1;
    }
    delay = swr_get_delay(media->swr, frame->sample_rate > 0 ? frame->sample_rate : media->out_rate);
    out_count = (int)av_rescale_rnd(delay + frame->nb_samples, media->out_rate,
                                    frame->sample_rate > 0 ? frame->sample_rate : media->out_rate, AV_ROUND_UP);
    if (out_count < frame->nb_samples) {
        out_count = frame->nb_samples;
    }
    if (out_count < 1) {
        return 0;
    }
    if (ensure_floats(&media->pcm, &media->pcm_cap, out_count * media->out_channels, err, err_len) < 0) {
        return -1;
    }
    planes[0] = (uint8_t *)media->pcm;
    got = swr_convert(media->swr, planes, out_count, (const uint8_t **)frame->extended_data, frame->nb_samples);
    if (got < 0) {
        set_averr(err, err_len, "resampling audio", got);
        return -1;
    }
    if (got == 0) {
        return 0;
    }
    out->samples = media->pcm;
    out->frames = got;
    out->channels = media->out_channels;
    out->rate = media->out_rate;
    out->pts = frame_pts(frame, media->fmt->streams[media->audio_index]);
    return 1;
}

int sweet_ffmpeg_next_audio(SweetMedia *media, SweetAudioChunk *out, char *err, size_t err_len) {
    int spins = 0;
    if (!media || !media->audio || !out) {
        set_err(err, err_len, "no audio stream");
        return -1;
    }
    for (;;) {
        int ret;
        int produced;
        if (media->swr_drained) {
            return 0;
        }
        ret = avcodec_receive_frame(media->audio, media->frame);
        if (ret == 0) {
            produced = emit_audio(media, media->frame, out, err, err_len);
            av_frame_unref(media->frame);
            if (produced < 0) {
                return -1;
            }
            if (produced == 0) {
                continue;
            }
            return 1;
        }
        if (ret == AVERROR_EOF || (ret == AVERROR(EAGAIN) && media->flush_sent_audio)) {
            int got;
            uint8_t *planes[1];
            int room;
            if (ensure_swr(media, err, err_len) < 0) {
                return -1;
            }
            room = 4096;
            if (ensure_floats(&media->pcm, &media->pcm_cap, room * media->out_channels, err, err_len) < 0) {
                return -1;
            }
            planes[0] = (uint8_t *)media->pcm;
            got = swr_convert(media->swr, planes, room, NULL, 0);
            media->swr_drained = 1;
            if (got < 0) {
                set_averr(err, err_len, "flushing audio resampler", got);
                return -1;
            }
            if (got == 0) {
                return 0;
            }
            out->samples = media->pcm;
            out->frames = got;
            out->channels = media->out_channels;
            out->rate = media->out_rate;
            out->pts = 0;
            return 1;
        }
        if (ret != AVERROR(EAGAIN)) {
            set_averr(err, err_len, "decoding audio", ret);
            return -1;
        }
        if (!media->packet_pending) {
            ret = av_read_frame(media->fmt, media->packet);
            if (ret == AVERROR_EOF) {
                ret = avcodec_send_packet(media->audio, NULL);
                media->flush_sent_audio = 1;
                if (ret < 0 && ret != AVERROR_EOF) {
                    set_averr(err, err_len, "flushing audio", ret);
                    return -1;
                }
                continue;
            }
            if (ret < 0) {
                set_averr(err, err_len, "reading audio", ret);
                return -1;
            }
            if (media->packet->stream_index != media->audio_index) {
                av_packet_unref(media->packet);
                continue;
            }
            media->packet_pending = 1;
        }
        ret = avcodec_send_packet(media->audio, media->packet);
        if (ret == 0) {
            av_packet_unref(media->packet);
            media->packet_pending = 0;
            spins = 0;
            continue;
        }
        if (ret == AVERROR(EAGAIN)) {
            if (++spins > 8) {
                set_err(err, err_len, "audio decoder stalled");
                return -1;
            }
            continue;
        }
        set_averr(err, err_len, "decoding audio", ret);
        return -1;
    }
}
