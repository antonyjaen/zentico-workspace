package dev.zentico.workspace;

import android.Manifest;
import android.app.DownloadManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import org.json.JSONObject;

/**
 * Zentico Workspace shell. The bundled launcher (https://localhost) picks the server; this activity
 * then lets that origin (plus its sign-in and office hosts) load in the WebView, gives the workspace
 * origin alone a tiny notification bridge, and handles downloads, offline fallback, back and deep links.
 */
public class MainActivity extends BridgeActivity {

    private static final String LAUNCHER = "https://localhost/";
    private static final String CHANNEL = "messages";
    private static final String EXTRA_NOTIFICATION = "zentico_notification_id";
    private static final String EXTRA_ORIGIN = "zentico_notification_origin";
    private static final int REQ_NOTIFICATIONS = 4101;

    private volatile Workspace workspace;
    private ScriptHandler shimHandle;
    private boolean listenerAdded;
    private boolean leftLauncher;
    private String pendingStart;
    private String pendingPrefill;
    private JavaScriptReplyProxy permissionReply;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(WorkspacePlugin.class);
        workspace = Workspace.load(this);
        super.onCreate(savedInstanceState);

        WebView web = bridge.getWebView();
        bridge.setWebViewClient(new ShellClient());
        web.setDownloadListener(this::download);
        installBridge();
        createChannel();

        // Back walks the WebView history; at its start the app goes to the background.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge.getWebView().canGoBack()) bridge.getWebView().goBack();
                else moveTaskToBack(true);
            }
        });
    }

    /* ------------------------------------------------------------ workspace */

    Workspace workspace() {
        return workspace;
    }

    synchronized String[] takePending() {
        String[] p = { pendingStart, pendingPrefill };
        pendingStart = null;
        pendingPrefill = null;
        return p;
    }

    /** Saves the chosen workspace and rebuilds the per-origin notification bridge for it. */
    void applyWorkspace(Workspace ws) {
        if (ws.equalsTo(workspace)) return;
        ws.save(this);
        workspace = ws;
        runOnUiThread(this::installBridge);
    }

    /* ------------------------------------------------------------ notifications */

    private String shimSource() {
        try (InputStream in = getResources().openRawResource(R.raw.notification_shim)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * window.Notification shim (document-start script) + "zenticoNative" message channel, both
     * restricted to the workspace origin. Without these WebView features notifications are off.
     */
    private void installBridge() {
        WebView web = bridge.getWebView();
        if (shimHandle != null) {
            shimHandle.remove();
            shimHandle = null;
        }
        if (listenerAdded) {
            WebViewCompat.removeWebMessageListener(web, "zenticoNative");
            listenerAdded = false;
        }
        if (workspace == null) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            return;
        }
        String shim = shimSource();
        if (shim == null) return;
        String origin = workspace.origin;
        try {
            shimHandle = WebViewCompat.addDocumentStartJavaScript(web, shim, Collections.singleton(origin));
            WebViewCompat.addWebMessageListener(web, "zenticoNative", Collections.singleton(origin), (view, message, source, isMainFrame, reply) -> {
                if (!isMainFrame || workspace == null || !workspace.isWorkspace(source)) return;
                onBridgeMessage(message.getData(), reply);
            });
            listenerAdded = true;
        } catch (RuntimeException e) {
            // Origin rejected or feature unavailable in this WebView: leave notifications off.
            android.util.Log.w("Zentico", "Notification bridge unavailable", e);
        }
    }

    private String permissionState() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // Not granted yet: the page may ask (Android shows its prompt until the user blocks it).
            return "default";
        }
        return NotificationManagerCompat.from(this).areNotificationsEnabled() ? "granted" : "denied";
    }

    private void replyPermission(JavaScriptReplyProxy reply) {
        try {
            reply.postMessage(new JSONObject().put("type", "permission").put("state", permissionState()).toString());
        } catch (Exception ignored) {}
    }

    private void onBridgeMessage(String data, JavaScriptReplyProxy reply) {
        if (data == null || data.length() > 4000) return;
        try {
            JSONObject m = new JSONObject(data);
            switch (m.optString("type")) {
                case "permission":
                    if (m.optBoolean("request") && Build.VERSION.SDK_INT >= 33 && !"granted".equals(permissionState())) {
                        permissionReply = reply;
                        ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFICATIONS);
                    } else {
                        replyPermission(reply);
                    }
                    break;
                case "notify":
                    notify(m.optInt("id"), m.optString("title"), m.optString("body"));
                    break;
                default:
                    break;
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_NOTIFICATIONS && permissionReply != null) {
            replyPermission(permissionReply);
            permissionReply = null;
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    private void notify(int id, String title, String body) {
        if (!"granted".equals(permissionState()) || workspace == null) return;
        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_NOTIFICATION, id)
            .putExtra(EXTRA_ORIGIN, workspace.origin);
        PendingIntent pi = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_zentico)
            .setContentTitle(truncate(title, 200))
            .setContentText(truncate(body, 1000))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(truncate(body, 1000)))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi);
        try {
            NotificationManagerCompat.from(this).notify(id, b.build());
        } catch (SecurityException ignored) {}
    }

    private static String truncate(String s, int max) {
        return s == null ? "" : s.length() > max ? s.substring(0, max) : s;
    }

    /* ------------------------------------------------------------ downloads */

    private void download(String url, String userAgent, String contentDisposition, String mimeType, long length) {
        Uri uri = Uri.parse(url);
        if (workspace == null || !workspace.allows(uri)) {
            // blob:/data: downloads (generated in the page) can't go through DownloadManager.
            Toast.makeText(this, R.string.download_unsupported, Toast.LENGTH_LONG).show();
            return;
        }
        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        DownloadManager.Request req = new DownloadManager.Request(uri)
            .setMimeType(mimeType)
            .addRequestHeader("User-Agent", userAgent)
            .setTitle(name)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null) req.addRequestHeader("Cookie", cookies);
        ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
        Toast.makeText(this, getString(R.string.downloading, name), Toast.LENGTH_SHORT).show();
    }

    /* ------------------------------------------------------------ intents */

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (bridge == null || intent == null) return;

        int nid = intent.getIntExtra(EXTRA_NOTIFICATION, 0);
        if (nid != 0 && workspace != null && workspace.origin.equals(intent.getStringExtra(EXTRA_ORIGIN))) {
            bridge.getWebView().evaluateJavascript("window.__zenticoNotificationClick&&window.__zenticoNotificationClick(" + nid + ")", null);
            return;
        }

        Uri data = intent.getData();
        if (data == null || !"zentico".equals(data.getScheme())) return;
        String host = data.getHost();
        String query = "";
        synchronized (this) {
            if ("setup".equals(host)) {
                query = "?setup=1";
            } else if ("open".equals(host) && data.getQueryParameter("server") != null) {
                pendingPrefill = truncate(data.getQueryParameter("server"), 300);
            } else if (workspace != null) {
                // zentico://chat/abc → <workspace>/chat/abc (always on the workspace origin).
                String path = (host != null ? host : "") + (data.getEncodedPath() != null ? data.getEncodedPath() : "");
                pendingStart = workspace.origin + "/" + path.replaceAll("^/+", "") +
                    (data.getEncodedQuery() != null ? "?" + data.getEncodedQuery() : "");
            }
        }
        // The launcher routes it (start page, setup prefill or setup screen).
        bridge.getWebView().loadUrl(LAUNCHER + query);
    }

    /* ------------------------------------------------------------ web view client */

    private class ShellClient extends BridgeWebViewClient {

        ShellClient() {
            super(bridge);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            boolean local = url != null && url.startsWith(LAUNCHER);
            // Drop the launcher from history once the workspace loads, so Back exits at its root.
            if (!local && leftLauncher) view.clearHistory();
            leftLauncher = local;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            Uri u = request.getUrl();
            if (request.isForMainFrame() && workspace != null && workspace.allows(u)) {
                view.loadUrl(LAUNCHER + "?offline=1");
            }
        }
    }
}
