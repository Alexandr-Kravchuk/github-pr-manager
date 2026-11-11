// prd-locate: the header weather's one location fix on macOS.
//
// Electron's navigator.geolocation does not use Location Services — it calls
// Google's paid geolocation service and, with no API key, never answers. So
// main runs this tiny helper app instead (main/locate.ts). It is its own
// bundle (prd-locate.app, LSUIElement, inside the app's Resources) because
// Location Services only prompts for a bundle that carries a usage string; a
// bare child binary stays "not determined" for ever.
//
// Prints one JSON line and exits: {"status":"ok","latitude":…,"longitude":…},
// {"status":"denied"}, {"status":"disabled"} (Location Services off),
// {"status":"error","code":N} or {"status":"timeout"}.

import CoreLocation
import Foundation

/// How long the user may take to answer the system prompt.
let promptTimeout: TimeInterval = 300
/// How long a fix may take once access is granted.
let fixTimeout: TimeInterval = 30

final class Locator: NSObject, CLLocationManagerDelegate {
  let manager = CLLocationManager()
  var requested = false

  func finish(_ obj: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: obj) {
      FileHandle.standardOutput.write(data)
    }
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
  }

  func start() {
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyKilometer
    if !CLLocationManager.locationServicesEnabled() { finish(["status": "disabled"]) }
    decide(manager.authorizationStatus)
  }

  func decide(_ status: CLAuthorizationStatus) {
    switch status {
    case .notDetermined:
      manager.requestWhenInUseAuthorization()
    case .denied, .restricted:
      finish(["status": "denied"])
    default:
      if requested { return }
      requested = true
      manager.requestLocation()
      DispatchQueue.main.asyncAfter(deadline: .now() + fixTimeout) { self.finish(["status": "timeout"]) }
    }
  }

  func locationManagerDidChangeAuthorization(_ m: CLLocationManager) { decide(m.authorizationStatus) }

  func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let c = locations.last?.coordinate else { return }
    finish(["status": "ok", "latitude": c.latitude, "longitude": c.longitude])
  }

  func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
    let code = (error as NSError).code
    // "Unknown for now": Core Location keeps trying; the fix timeout ends it.
    if code == CLError.locationUnknown.rawValue { return }
    finish(code == CLError.denied.rawValue ? ["status": "denied"] : ["status": "error", "code": code])
  }
}

let locator = Locator()
locator.start()
DispatchQueue.main.asyncAfter(deadline: .now() + promptTimeout) { locator.finish(["status": "timeout"]) }
RunLoop.main.run()
