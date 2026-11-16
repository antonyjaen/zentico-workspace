import UIKit
import Capacitor
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

// MARK: - Zentico Workspace shell
// Kept in this file (already part of the Xcode target) so no project.pbxproj edits are needed.
// Untested: written on Windows without Xcode; build and check on a Mac before shipping.

/// Root view controller (Main.storyboard): registers the app's own Workspace plugin.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(WorkspacePlugin())
    }
}

/// Bridge for the bundled launcher page (Capacitor injects its bridge into the local app origin
/// only, so the remote workspace cannot call it) and owner of the runtime navigation allow-list.
@objc(WorkspacePlugin)
public class WorkspacePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WorkspacePlugin"
    public let jsName = "Workspace"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getLaunch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWorkspace", returnType: CAPPluginReturnPromise)
    ]

    private struct Workspace {
        let origin: String
        let authHost: String?
        let officeHost: String?

        /// https only; host[:port] with DNS-safe characters.
        static func make(_ origin: String?, _ auth: String?, _ office: String?) -> Workspace? {
            guard let origin = origin, let u = URLComponents(string: origin.trimmingCharacters(in: .whitespaces)),
                  u.scheme == "https", let host = u.host?.lowercased(), host != "localhost", u.user == nil,
                  let o = authority(host, u.port), valid(o) else { return nil }
            func clean(_ h: String?) -> (ok: Bool, value: String?) {
                guard let h = h?.trimmingCharacters(in: .whitespaces).lowercased(), !h.isEmpty else { return (true, nil) }
                return valid(h) ? (true, h) : (false, nil)
            }
            let a = clean(auth), f = clean(office)
            guard a.ok, f.ok else { return nil }
            return Workspace(origin: "https://" + o, authHost: a.value, officeHost: f.value)
        }

        static func authority(_ host: String, _ port: Int?) -> String? {
            if let p = port, p != 443 { return "\(host):\(p)" }
            return host
        }

        static func valid(_ a: String) -> Bool {
            a.count <= 253 && a.range(of: "^[a-z0-9.-]+(:[0-9]{1,5})?$", options: .regularExpression) != nil
        }

        func allows(_ url: URL) -> Bool {
            guard url.scheme == "https", let host = url.host?.lowercased(),
                  let a = Workspace.authority(host, url.port) else { return false }
            return origin == "https://" + a || a == authHost || a == officeHost
        }
    }

    private static let store = UserDefaults.standard
    private var pendingStart: String?
    private var pendingPrefill: String?

    private static func load() -> Workspace? {
        Workspace.make(store.string(forKey: "zentico.origin"), store.string(forKey: "zentico.authHost"), store.string(forKey: "zentico.officeHost"))
    }

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(openURL(_:)), name: .capacitorOpenURL, object: nil)
    }

    @objc func getLaunch(_ call: CAPPluginCall) {
        var res: [String: Any] = ["start": pendingStart ?? NSNull(), "prefill": pendingPrefill ?? NSNull()]
        pendingStart = nil
        pendingPrefill = nil
        if let ws = Self.load() {
            res["workspace"] = ["origin": ws.origin, "authHost": ws.authHost ?? NSNull(), "officeHost": ws.officeHost ?? NSNull()]
        } else {
            res["workspace"] = NSNull()
        }
        call.resolve(res)
    }

    @objc func setWorkspace(_ call: CAPPluginCall) {
        guard let ws = Workspace.make(call.getString("origin"), call.getString("authHost"), call.getString("officeHost")) else {
            call.reject("Invalid workspace")
            return
        }
        Self.store.set(ws.origin, forKey: "zentico.origin")
        Self.store.set(ws.authHost, forKey: "zentico.authHost")
        Self.store.set(ws.officeHost, forKey: "zentico.officeHost")
        call.resolve()
    }

    /// false = load in the app; nil = Capacitor's default (app origin stays, others open in Safari).
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url, let ws = Self.load(), ws.allows(url) else { return nil }
        return false
    }

    /// zentico://setup, zentico://open?server=… (setup prefill), zentico://<path> (path on the workspace).
    @objc func openURL(_ note: Notification) {
        guard let url = (note.object as? [String: Any])?["url"] as? URL, url.scheme == "zentico",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        var query = ""
        if url.host == "setup" {
            query = "?setup=1"
        } else if url.host == "open", let server = comps.queryItems?.first(where: { $0.name == "server" })?.value {
            pendingPrefill = String(server.prefix(300))
        } else if let ws = Self.load() {
            let path = ((url.host ?? "") + url.path).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            pendingStart = ws.origin + "/" + path + (comps.percentEncodedQuery.map { "?" + $0 } ?? "")
        }
        DispatchQueue.main.async { [weak self] in
            guard let base = self?.bridge?.config.localURL, let target = URL(string: base.absoluteString + "/" + query) else { return }
            self?.bridge?.webView?.load(URLRequest(url: target))
        }
    }
}
