package org.nasty.vitrola;

import android.util.Log;

import com.chaquo.python.Python;

import org.nasty.NastyActivity;

import dev.ffmpegkit_maintained.ytdlp.YtDlp;
import dev.ffmpegkit_maintained.ytdlp.YtDlpException;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Vitrola's activity. Nasty's ytdlpExtract() calls nastyYtdlpExtractInfo through JNI from a
 * worker thread; yt-dlp runs in the Python runtime embedded by the yt-dlp-android library.
 */
public final class VitrolaActivity extends NastyActivity {
    private static final String TAG = "Vitrola";
    private static final Object updateLock = new Object();
    private static boolean updateChecked;

    public String nastyYtdlpExtractInfo(String source, boolean flat) throws YtDlpException {
        YtDlp.init(this);
        useLatestYtDlp();
        return YtDlp.extractInfoJson(this, source, flat, 20);
    }

    // The APK bundles yt-dlp as of its build, and sites change often. Before yt_dlp is first
    // imported, fetch the newest release's zipapp (pure Python, importable as is) and put it
    // first on sys.path. Offline or on any failure, the last download or the bundled copy runs.
    private void useLatestYtDlp() {
        synchronized (updateLock) {
            if (updateChecked) return;
            updateChecked = true;
            File dir = new File(getFilesDir(), "yt-dlp");
            File zip = new File(dir, "yt-dlp.zip");
            File stamp = new File(dir, "release");
            try {
                String url = latestZipappUrl();
                if (!zip.isFile() || !url.equals(readText(stamp))) {
                    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("can't create " + dir);
                    File partial = new File(dir, "yt-dlp.zip.part");
                    try (InputStream in = open(url); OutputStream out = new FileOutputStream(partial)) {
                        copy(in, out);
                    }
                    if (!partial.renameTo(zip)) throw new IOException("can't replace " + zip);
                    Files.write(stamp.toPath(), url.getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception error) {
                Log.w(TAG, "Couldn't update yt-dlp, using " + (zip.isFile() ? "the last download" : "the bundled copy"), error);
            }
            if (zip.isFile()) {
                Python.getInstance().getModule("sys").get("path").callAttr("insert", 0, zip.getAbsolutePath());
            }
        }
    }

    private static String latestZipappUrl() throws Exception {
        String json;
        try (InputStream in = open("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            copy(in, bytes);
            json = bytes.toString("UTF-8");
        }
        JSONArray assets = new JSONObject(json).getJSONArray("assets");
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            // "yt-dlp" (no suffix) is the platform-independent zipapp.
            if ("yt-dlp".equals(asset.getString("name"))) return asset.getString("browser_download_url");
        }
        throw new IOException("latest yt-dlp release has no zipapp");
    }

    private static InputStream open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("User-Agent", "Vitrola");
        connection.setInstanceFollowRedirects(true);
        int status = connection.getResponseCode();
        if (status != 200) throw new IOException(url + " answered " + status);
        return connection.getInputStream();
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        for (int n; (n = in.read(buffer)) != -1; ) out.write(buffer, 0, n);
    }

    private static String readText(File file) {
        try {
            return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        } catch (IOException error) {
            return "";
        }
    }
}
