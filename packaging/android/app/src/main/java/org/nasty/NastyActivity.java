package org.nasty;

import android.app.NativeActivity;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

/**
 * NativeActivity that reports the system bar sizes to Nasty, so Window#safeArea can keep
 * content clear of them. The window itself stays edge to edge (Android does not let an
 * opaque main window fit its insets); Nasty renders into the band between the bars.
 * A plain NativeActivity reports nothing, so safeArea has no effect there.
 */
public class NastyActivity extends NativeActivity {
    private static native void nastyInsetsChanged(int top, int bottom);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // NativeActivity loaded libnasty_native without registering it for this class's native
        // methods; loading it again (already in memory, so nothing reinitializes) does.
        try {
            System.loadLibrary("nasty_native");
        } catch (UnsatisfiedLinkError error) {
            Log.w("Nasty", "safe area insets unavailable: " + error);
        }
        View decor = getWindow().getDecorView();
        decor.setOnApplyWindowInsetsListener((view, insets) -> {
            report(insets);
            return view.onApplyWindowInsets(insets);
        });
        decor.requestApplyInsets();
    }

    /**
     * Called by Nasty (from its own thread) for fullscreen: hides the status and navigation
     * bars (an edge swipe shows them briefly), or brings them back.
     */
    public void nastySetImmersive(boolean immersive) {
        runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowInsetsController controller = getWindow().getInsetsController();
                if (controller == null) return;
                if (immersive) {
                    controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    controller.hide(WindowInsets.Type.systemBars());
                } else {
                    controller.show(WindowInsets.Type.systemBars());
                }
            } else {
                View decor = getWindow().getDecorView();
                decor.setSystemUiVisibility(immersive
                    ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    : 0);
            }
        });
    }

    private static void report(WindowInsets insets) {
        int top;
        int bottom;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            top = insets.getInsets(WindowInsets.Type.statusBars() | WindowInsets.Type.displayCutout()).top;
            bottom = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
        } else {
            top = insets.getSystemWindowInsetTop();
            bottom = insets.getSystemWindowInsetBottom();
        }
        try {
            nastyInsetsChanged(top, bottom);
        } catch (UnsatisfiedLinkError error) {
            Log.w("Nasty", "safe area insets not delivered: " + error);
        }
    }
}
