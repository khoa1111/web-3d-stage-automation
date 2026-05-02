# Stage LED Mapping Tool

Website hoàn chỉnh để **đọc file 3D phối cảnh sân khấu (xuất từ SketchUp)**, **chọn các tấm LED** trong khung 3D, rồi **bố trí lại các tấm LED đó trên mặt phẳng 2D** để khớp với mapled (sơ đồ pixel) đã được nhà cung cấp LED chuyển sang.

Dự án là một trang web tĩnh, chạy hoàn toàn trên trình duyệt — không cần backend, không cần build step. Chỉ cần serve thư mục bằng bất kỳ HTTP server nào.

---

## 1. Tính năng chính

- **Import file 3D từ SketchUp** ở các định dạng phổ thông SketchUp xuất ra:
  `.gltf` / `.glb` (khuyến nghị), `.dae` (Collada – mặc định của SketchUp), `.obj`, `.fbx`.
  > File `.skp` gốc của SketchUp dùng định dạng đóng nên phải Export sang một trong các định dạng trên trong SketchUp trước khi import.
- **3D Viewer** với điều khiển quỹ đạo (xoay, pan, zoom), preset camera (Front / Top / Left / Right / Iso), bật/tắt lưới và wireframe.
- **Click-to-select**: click thẳng vào tấm LED trong khung 3D để đánh dấu thành "LED panel".
- **Tự động phát hiện LED** dựa trên tên object / material.
- **Cây đối tượng** với **checkbox + Shift** để chọn nhiều cùng lúc (như Finder/Explorer).
- **2D Mapping editor** trên canvas: drag, resize 8 hướng, xoay, snap-to-grid.
- **Marquee selection**: kéo chuột trên vùng trống để chọn nhiều LED bằng khung chữ nhật.
- **Mapled hỗ trợ ảnh và video**: chế độ **Preview** chiếu video lên các tấm LED, có **Mask** để tô tối khu vực ngoài LED.
- **Undo Ctrl+Z / Cmd+Z** (lưu 5 bước gần nhất).
- **Lưu / Mở dự án trong trình duyệt** (localStorage), tự động lưu phiên hiện tại để mở lại sau.
- **Tự động chiếu vị trí 2D từ 3D**.
- **Tính toán pixel** theo pixel pitch (mm) và kích thước thật (mm).
- **Drag & drop**: thả file 3D / ảnh / video vào trang là tự động xử lý.
- **Phím tắt**: `Ctrl+Z` undo · `Ctrl+S` lưu · `Ctrl+O` mở · `1` 3D · `2` 2D · `V` select · `H` pan · `F/T/L/R/I` camera · `Space` fit · `R` xoay 90° · `Del` bỏ chọn LED · `Esc` clear selection.

---

## 2. Cách chạy

Vì site dùng ES module + import map nên cần serve qua HTTP (không mở trực tiếp file://).

```bash
# Lựa chọn 1: Python
python3 -m http.server 8080

# Lựa chọn 2: Node
npx serve .

# Lựa chọn 3: PHP
php -S localhost:8080
```

Mở trình duyệt vào <http://localhost:8080>.

> Yêu cầu trình duyệt hỗ trợ ES modules + WebGL2 (Chrome/Edge/Firefox/Safari mới).

---

## 3. Quy trình sử dụng

1. **Xuất file từ SketchUp** sang `.dae` hoặc `.gltf`:
   File → Export → 3D Model → chọn định dạng `.dae` (Collada) hoặc cài plugin GLTF.
2. **Import vào website**: bấm **📂 Mở file 3D** (hoặc kéo thả file vào trang).
3. **Chọn các tấm LED**:
   - Click trực tiếp vào tấm LED trong khung 3D, hoặc
   - Bấm **🔎 Tự động phát hiện LED** ở sidebar trái, hoặc
   - Dùng **checkbox + Shift** trong cây đối tượng để chọn nhiều cùng lúc.
4. **Tải mapled tham chiếu** (ảnh hoặc video): bấm **🖼️ Mapled / Video**.
5. **Chuyển sang tab "2D Mapping"** và:
   - Bấm **⊞ Tự sắp theo 3D** để có layout khởi tạo từ vị trí 3D.
   - Drag / resize / xoay từng tấm, hoặc kéo marquee để chọn nhiều LED cùng lúc.
   - Bấm **▶ Preview** để xem video chiếu lên các LED, **◐ Mask** để tô tối khu vực ngoài.
6. **Lưu dự án**: bấm **💾 Lưu dự án** (Ctrl+S) để lưu vào trình duyệt. Mở lại bằng **📁 Mở dự án** (Ctrl+O). Phiên hiện tại được tự động lưu, nếu đóng tab thì lần sau mở sẽ có lựa chọn khôi phục.

---

## 4. Cấu trúc dự án

```
.
├── index.html              # Markup chính + import map cho three.js
├── assets/
│   └── FS_wth_favicon.svg  # Logo công ty / favicon
├── styles/
│   └── main.css            # Toàn bộ style (dark UI)
├── src/
│   ├── main.js             # Bootstrap + wiring
│   ├── fileLoader.js       # Loader cho gltf/obj/dae/fbx
│   ├── viewer3d.js         # Three.js scene, picking, camera presets
│   ├── editor2d.js         # Canvas 2D editor (drag/resize/rotate/marquee/preview)
│   ├── ledManager.js       # State LED + serialize/restore + auto-arrange
│   ├── ui.js               # Object tree (checkbox), LED list, properties, stats
│   ├── undoStack.js        # Undo Ctrl+Z (5 bước)
│   ├── sectionsManager.js  # Lưu / mở dự án localStorage + auto-save
│   └── utils.js            # Helpers chung (toast, file I/O, màu…)
└── README.md
```

---

## 5. Định dạng dự án (lưu trong localStorage)

Mỗi dự án lưu dưới khoá `fs.stage.project.<encodedName>`. Phiên hiện tại tự động lưu vào `fs.stage.autosave.current` mỗi khi có thay đổi (debounced 500ms).

```jsonc
{
  "v": 1,
  "name": "Sân khấu Gala 2026",
  "savedAt": "2026-05-01T10:11:12.000Z",
  "ledCount": 6,
  "pixelPitch": 3.9,
  "selection": ["led_xxxxx"],
  "leds": [
    {
      "id": "led_xxxxx",
      "meshUuid": "abc-123",
      "name": "LED_Main_Back",
      "color": "hsl(210, 75%, 55%)",
      "realW": 12000, "realH": 6000,
      "pixelW": 3072, "pixelH": 1536,
      "pixelPitch": 3.9,
      "world": { "cx": 0, "cy": 4, "cz": -5, "rx": 0, "ry": 0, "rz": 0, "sx": 12, "sy": 6, "sz": 0.15 },
      "map2d": { "x": 60, "y": 60, "w": 1200, "h": 600, "rotation": 0 }
    }
  ],
  "view": { "scale": 1, "tx": 0, "ty": 0, "mapledPos": {"x":60,"y":60,"scale":1}, "opacity": 0.6 }
}
```

> Ảnh / video mapled **không** được lưu trong dự án (để tiết kiệm dung lượng). Khi mở lại dự án, hãy nạp lại file mapled nếu cần.

---

## 6. Ghi chú kỹ thuật

- Three.js được nạp qua CDN (`unpkg.com/three@0.161.0`). Có thể chuyển sang bản tự host bằng cách đổi `importmap` trong `index.html`.
- Canvas 2D dùng `devicePixelRatio` để render sắc nét trên màn hình HiDPI.
- Pixel resolution được tính lại tự động từ `realW / pixelPitch`. Khi user resize tấm LED bằng tay trong 2D, kích thước thật cũng được suy ra theo tỷ lệ 100 px = 1 m (mặc định của canvas).
- Không có dependency npm — toàn bộ là static HTML/CSS/JS, deploy được lên GitHub Pages, S3, Netlify, v.v…
