import AppKit
import Foundation

// This is native image-view layout: the original artwork is drawn unchanged,
// with its existing scale and a translation. Only empty background is clipped.
let arguments = CommandLine.arguments
guard arguments.count == 3,
      let data = try? Data(contentsOf: URL(fileURLWithPath: arguments[1])),
      let pixels = NSBitmapImageRep(data: data),
      let source = pixels.cgImage,
      let background = pixels.colorAt(x: 0, y: 0)?.usingColorSpace(.sRGB) else {
    fatalError("Cannot read original icon")
}

func visibleBounds(_ image: NSBitmapImageRep) -> (x: Int, y: Int, width: Int, height: Int)? {
    var left = image.pixelsWide, top = image.pixelsHigh, right = -1, bottom = -1
    for y in 0..<image.pixelsHigh {
        for x in 0..<image.pixelsWide {
            guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.sRGB), color.alphaComponent > 0.05 else { continue }
            let contrast = max(abs(color.redComponent - background.redComponent),
                               abs(color.greenComponent - background.greenComponent),
                               abs(color.blueComponent - background.blueComponent))
            guard contrast > 20.0 / 255.0 else { continue }
            left = min(left, x); top = min(top, y); right = max(right, x); bottom = max(bottom, y)
        }
    }
    return right >= left && bottom >= top ? (left, top, right - left + 1, bottom - top + 1) : nil
}

guard let bounds = visibleBounds(pixels) else { fatalError("Icon has no visible artwork") }
let outputSize = 1024
let scale = CGFloat(outputSize) / CGFloat(max(pixels.pixelsWide, pixels.pixelsHigh))
let centerX = CGFloat(bounds.x) + CGFloat(bounds.width) / 2
// Bitmap rows start at the top; AppKit drawing coordinates start at the bottom.
let centerY = CGFloat(pixels.pixelsHigh) - CGFloat(bounds.y) - CGFloat(bounds.height) / 2
var drawRect = NSRect(x: CGFloat(outputSize) / 2 - centerX * scale,
                      y: CGFloat(outputSize) / 2 - centerY * scale,
                      width: CGFloat(pixels.pixelsWide) * scale,
                      height: CGFloat(pixels.pixelsHigh) * scale)
func render() -> NSBitmapImageRep {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: outputSize, height: outputSize, bitsPerComponent: 8,
              bytesPerRow: outputSize * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let backgroundPixel = source.cropping(to: CGRect(x: 0, y: 0, width: 1, height: 1)) else {
        fatalError("Cannot create icon tile")
    }
    // Use the same source color conversion for the tile and image, so drawing
    // the source rectangle cannot introduce a second shade of black.
    context.interpolationQuality = .none
    context.draw(backgroundPixel, in: CGRect(x: 0, y: 0, width: outputSize, height: outputSize))
    context.interpolationQuality = .high
    context.draw(source, in: drawRect)
    guard let image = context.makeImage() else { fatalError("Cannot render icon") }
    return NSBitmapImageRep(cgImage: image)
}
var output = render()
guard let initial = visibleBounds(output) else { fatalError("Rendered icon has no artwork") }
// Correct the subpixel edge difference introduced by high quality resampling.
let initialErrorX = CGFloat(initial.x) + CGFloat(initial.width) / 2 - CGFloat(outputSize) / 2
let initialErrorY = CGFloat(initial.y) + CGFloat(initial.height) / 2 - CGFloat(outputSize) / 2
drawRect.origin.x -= initialErrorX
drawRect.origin.y += initialErrorY
output = render()
guard let actual = visibleBounds(output) else { fatalError("Rendered icon has no artwork") }
let errorX = Double(actual.x) + Double(actual.width) / 2 - Double(outputSize) / 2
let errorY = Double(actual.y) + Double(actual.height) / 2 - Double(outputSize) / 2
guard let png = output.representation(using: .png, properties: [:]) else { fatalError("Cannot encode icon") }
try png.write(to: URL(fileURLWithPath: arguments[2]), options: .atomic)
guard abs(errorX) <= 1, abs(errorY) <= 1 else {
    fputs("Icon bounds: \(bounds); output: \(actual); center error: \(errorX), \(errorY)\n", stderr)
    exit(1)
}
let result: [String: Any] = [
    "width": pixels.pixelsWide, "height": pixels.pixelsHigh,
    "sourceVisibleBounds": [bounds.x, bounds.y, bounds.width, bounds.height],
    "outputVisibleBounds": [actual.x, actual.y, actual.width, actual.height],
    "centerErrorPixels": [errorX, errorY], "scale": Double(scale)
]
let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: json, encoding: .utf8)!)
