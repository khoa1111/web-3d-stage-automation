# Stage LED Mapping Tool

Website hoàn chỉnh để **đọc file 3D phối cảnh sân khấu (xuất từ SketchUp)**, **chọn các tấm LED** trong khung 3D, rồi **bố trí lại các tấm LED đó trên mặt phẳng 2D** để khớp với mapled (sơ đồ pixel) đã được nhà cung cấp LED chuyển sang.

Dự án là một trang web tĩnh, chạy hoàn toàn trên trình duyệt — không cần backend, không cần build step. Chỉ cần serve thư mục bằng bất kỳ HTTP server nào.

---

## 1. Tính năng chính

- **Import file 3D từ SketchUp** ở các định dạng phổ thông SketchUp xuất ra:
  `.gltf` / `.glb` (khuyến nghị), `.dae` (Collada – mặc định của SketchUp), `.obj`, `.fbx`.
  > File `.skp` gốc của SketchUp dùng định dạng đóng nên phải Export sang một trong các định dạng trên trong SketchUp trước khi import.
- **3D Viewer** với điều khiển quỹ đạo (xoay, pan, zoom), preset camera (Front / Top / Left / Right / Iso), bật/tắt lưới và wireframe.
- **Click-to-select**: click thẳng vào tấm LED trong khung 3D để đánh dấu thành "LED panel" — vật liệu mesh được tô màu nổi bật để dễ nhận biết.
- **Tự động phát hiện LED** dựa trên tên object / material (`LED`, `panel`, `screen`, `display`, `man hinh`, …).
- **Cây đối tượng** (object tree) ở sidebar trái với search.
- **2D Mapping editor** trên canvas: drag, resize 8 hướng, xoay, snap-to-grid, zoom (Ctrl + lăn chuột), pan (giữ chuột giữa).
- **Mapled tham chiếu**: nạp ảnh sơ đồ LED của nhà cung cấp làm background mờ, sau đó kéo các tấm LED khớp lên trên.
- **Tự động chiếu vị trí 2D từ 3D**: lấy toạ độ centre của mỗi tấm LED trong không gian 3D và xếp sang canvas 2D.
- **Tính toán pixel** theo pixel pitch (mm) và kích thước thật (mm) → ra số pixel ngang/dọc và tổng thông số dự án (tổng pixel, diện tích m²…).
- **Properties panel** đầy đủ: tên, màu, kích thước thật, pixel pitch, độ phân giải, vị trí 2D & 3D.
- **Export / Import cấu hình JSON** để lưu và tái sử dụng phiên làm việc.
- **Drag & drop**: thả file 3D / ảnh mapled / file JSON vào trang là tự động xử lý.
- **Phím tắt**: `1` 3D · `2` 2D · `F/T/L/R/I` camera · `Space` fit · `R` xoay 90° trong 2D · `Del` bỏ chọn LED · `Esc` clear selection.

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
   Nếu chưa có file thật, bấm **✨ Demo sân khấu** để tạo nhanh một sân khấu mẫu có sẵn 6 tấm LED.
3. **Chọn các tấm LED**:
   - Click trực tiếp vào tấm LED trong khung 3D, hoặc
   - Bấm **🔎 Tự động phát hiện LED** ở sidebar trái nếu các object có tên/material chứa từ khoá LED.
4. **Tải mapled tham chiếu** (ảnh sơ đồ LED): bấm **🖼️ Mapled tham chiếu**. Ảnh sẽ hiện mờ phía sau canvas 2D.
5. **Chuyển sang tab "2D Mapping"** và:
   - Bấm **⊞ Tự sắp theo 3D** để có layout khởi tạo từ vị trí 3D.
   - Drag / resize / xoay từng tấm LED khớp với mapled.
   - Chỉnh **pixel pitch** (mm), **kích thước thật**, độ phân giải trong panel Thuộc tính bên phải.
6. **Xuất cấu hình**: bấm **⬇️ Export** để tải file JSON. File này chứa toàn bộ vị trí 2D, kích thước, pixel resolution của từng tấm — có thể nạp lại sau bằng **⬆️ Import config**.

---

## 4. Cấu trúc dự án

```
.
├── index.html              # Markup chính + import map cho three.js
├── styles/
│   └── main.css            # Toàn bộ style (dark UI)
├── src/
│   ├── main.js             # Bootstrap + wiring
│   ├── fileLoader.js       # Loader cho gltf/obj/dae/fbx + demo stage
│   ├── viewer3d.js         # Three.js scene, picking, camera presets
│   ├── editor2d.js         # Canvas 2D editor (drag/resize/rotate/snap)
│   ├── ledManager.js       # State LED + export/import + auto-arrange
│   ├── ui.js               # Object tree, LED list, properties, stats
│   └── utils.js            # Helpers chung (toast, file I/O, màu…)
└── README.md
```

---

## 5. Định dạng file Export

```jsonc
{
  "version": 1,
  "generatedAt": "2026-04-30T10:11:12.000Z",
  "pixelPitch": 3.9,
  "model": "DemoStage",
  "totals": { "count": 6, "pixelWidthSum": 12288, "pixelHeightMax": 1536, "areaM2": 102.5 },
  "leds": [
    {
      "id": "led_xxxxx",
      "name": "LED_Main_Back",
      "color": "hsl(210, 75%, 55%)",
      "realW": 12000, "realH": 6000,
      "pixelW": 3072, "pixelH": 1536,
      "pixelPitch": 3.9,
      "world": { "cx": 0, "cy": 4, "cz": -5, "rx": 0, "ry": 0, "rz": 0, "sx": 12, "sy": 6, "sz": 0.15 },
      "map2d": { "x": 60, "y": 60, "w": 1200, "h": 600, "rotation": 0 }
    }
  ]
}
```

---

## 6. Ghi chú kỹ thuật

- Three.js được nạp qua CDN (`unpkg.com/three@0.161.0`). Có thể chuyển sang bản tự host bằng cách đổi `importmap` trong `index.html`.
- Canvas 2D dùng `devicePixelRatio` để render sắc nét trên màn hình HiDPI.
- Pixel resolution được tính lại tự động từ `realW / pixelPitch`. Khi user resize tấm LED bằng tay trong 2D, kích thước thật cũng được suy ra theo tỷ lệ 100 px = 1 m (mặc định của canvas).
- Không có dependency npm — toàn bộ là static HTML/CSS/JS, deploy được lên GitHub Pages, S3, Netlify, v.v…
