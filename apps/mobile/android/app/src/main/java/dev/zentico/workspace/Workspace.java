package dev.zentico.workspace;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.util.regex.Pattern;

/**
 * The workspace server chosen on the bundled setup page, persisted in SharedPreferences.
 * Its origin, sign-in host and office host form the in-app navigation allow-list.
 */
final class Workspace {

    private static final String PREFS = "zentico_workspace";
    private static final Pattern AUTHORITY = Pattern.compile("^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$");

    final String origin;
    final String authHost;
    final String officeHost;

    private Workspace(String origin, String authHost, String officeHost) {
        this.origin = origin;
        this.authHost = authHost;
        this.officeHost = officeHost;
    }

    /** Validates and normalizes; returns null when anything is off. Mobile accepts https only. */
    static Workspace of(String origin, String authHost, String officeHost) {
        String o = normalizeOrigin(origin);
        if (o == null) return null;
        String a = cleanHost(authHost);
        String f = cleanHost(officeHost);
        if ((authHost != null && !authHost.isEmpty() && a == null) || (officeHost != null && !officeHost.isEmpty() && f == null)) {
            return null;
        }
        return new Workspace(o, a, f);
    }

    static String normalizeOrigin(String input) {
        if (input == null) return null;
        Uri u = Uri.parse(input.trim());
        String host = u.getHost();
        if (!"https".equals(u.getScheme()) || host == null || u.getUserInfo() != null) return null;
        String authority = host.toLowerCase() + (u.getPort() > 0 && u.getPort() != 443 ? ":" + u.getPort() : "");
        if (!AUTHORITY.matcher(authority).matches() || "localhost".equals(host)) return null;
        return "https://" + authority;
    }

    private static String cleanHost(String h) {
        if (h == null || h.trim().isEmpty()) return null;
        String v = h.trim().toLowerCase();
        return AUTHORITY.matcher(v).matches() ? v : null;
    }

    static Workspace load(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return of(p.getString("origin", null), p.getString("authHost", null), p.getString("officeHost", null));
    }

    void save(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("origin", origin)
            .putString("authHost", authHost)
            .putString("officeHost", officeHost)
            .apply();
    }

    /** host[:port] as JS `URL.host` reports it (port only when non-default). */
    private static String authority(Uri url) {
        String host = url.getHost();
        if (host == null) return null;
        int port = url.getPort();
        return host.toLowerCase() + (port > 0 && port != 443 ? ":" + port : "");
    }

    boolean isWorkspace(Uri url) {
        return "https".equals(url.getScheme()) && origin.equals("https://" + authority(url));
    }

    /** May this URL load inside the app (workspace, its sign-in host, its office host)? */
    boolean allows(Uri url) {
        if (!"https".equals(url.getScheme())) return false;
        String a = authority(url);
        return a != null && (origin.equals("https://" + a) || a.equals(authHost) || a.equals(officeHost));
    }

    boolean equalsTo(Workspace other) {
        return other != null && origin.equals(other.origin) && eq(authHost, other.authHost) && eq(officeHost, other.officeHost);
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }
}
