package dev.zentico.workspace;

import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridge for the bundled launcher page (https://localhost only: Capacitor injects its bridge into
 * the app origin alone, so the remote workspace cannot call this). Also owns the runtime
 * navigation allow-list through shouldOverrideLoad.
 */
@CapacitorPlugin(name = "Workspace")
public class WorkspacePlugin extends Plugin {

    private MainActivity main() {
        return (MainActivity) getActivity();
    }

    @PluginMethod
    public void getLaunch(PluginCall call) {
        MainActivity a = main();
        JSObject res = new JSObject();
        Workspace ws = a.workspace();
        if (ws != null) {
            JSObject w = new JSObject();
            w.put("origin", ws.origin);
            w.put("authHost", ws.authHost);
            w.put("officeHost", ws.officeHost);
            res.put("workspace", w);
        } else {
            res.put("workspace", JSObject.NULL);
        }
        String[] pending = a.takePending();
        res.put("start", pending[0] != null ? pending[0] : JSObject.NULL);
        res.put("prefill", pending[1] != null ? pending[1] : JSObject.NULL);
        call.resolve(res);
    }

    @PluginMethod
    public void setWorkspace(PluginCall call) {
        Workspace ws = Workspace.of(call.getString("origin"), call.getString("authHost"), call.getString("officeHost"));
        if (ws == null) {
            call.reject("Invalid workspace");
            return;
        }
        // Save (and update the allow-list) before resolving: the launcher navigates on resolve.
        // The notification bridge is rebuilt afterwards on the UI thread and never blocks the reply.
        main().applyWorkspace(ws);
        call.resolve();
    }

    /** false = load in the app; null = Capacitor's default (app origin stays, others open externally). */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        Workspace ws = main().workspace();
        if (ws != null && ws.allows(url)) return false;
        return null;
    }
}
