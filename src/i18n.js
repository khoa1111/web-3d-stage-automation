// Lightweight i18n. Two languages: vi (default) and en.
//
// Usage from JS:   import { t, i18n } from './i18n.js';  t('toolbar.select')
// Usage in HTML:   <button data-i18n="toolbar.select">Select</button>
//                  <input data-i18n-attr="placeholder:search.objects" />
//                  <button data-i18n-title="tooltip.lock"></button>
//
// applyTo(root) translates all elements under root that carry one of the
// data attributes above. Calling i18n.setLang() re-applies translations and
// fires a 'change' event so dynamic UI (LED list, props panel, etc.) can
// re-render.

const STORAGE_KEY = 'fs.stage.lang';

const DICT = {
  vi: {
    'app.title': 'Sân Khấu LED',
    'app.subtitle': '◆ Felic Studio · 3D → 2D',

    'topbar.openModel': 'Mở mô hình 3D',
    'topbar.openModel.title': 'Nhập mô hình 3D (.gltf, .glb, .obj, .dae, .fbx)',
    'topbar.mapled': 'Mapled / Video',
    'topbar.mapled.title': 'Tải ảnh hoặc video tham chiếu',
    'topbar.mode3d': 'Xem 3D',
    'topbar.mode2d': 'Mapping 2D',
    'topbar.save': 'Lưu',
    'topbar.save.title': 'Lưu dự án (Ctrl+S)',
    'topbar.open': 'Dự án',
    'topbar.open.title': 'Mở dự án (Ctrl+O)',
    'topbar.freezeAll': 'Khóa tất cả',
    'topbar.unfreezeAll': 'Mở khóa tất cả',
    'topbar.freezeAll.title': 'Khóa hoặc mở khóa toàn bộ LED',
    'topbar.lang.title': 'Chuyển ngôn ngữ',
    'video.play': 'Phát',
    'video.pause': 'Tạm dừng',

    'panel.objects': '◆ Cây đối tượng',
    'panel.leds': '◆ Bảng LED',
    'panel.props': '◆ Thuộc tính',
    'panel.overview': '◆ Tổng quan dự án',
    'panel.guide': '◆ Hướng dẫn nhanh',

    'search.objects': 'Tìm theo tên…',
    'btn.autodetect': 'Tự nhận diện LED',
    'btn.clearAll': 'Xóa tất cả',
    'btn.groupSelected': 'Tạo nhóm',
    'btn.groupSelected.title': 'Gán các LED đang chọn vào một nhóm',
    'group.lock.title': 'Khóa cả nhóm',
    'group.unlock.title': 'Mở khóa cả nhóm',
    'group.overlay.show.title': 'Hiện phủ Mapled (ẩn các tấm LED của nhóm này)',
    'group.overlay.hide.title': 'Ẩn phủ Mapled (hiện lại các tấm LED của nhóm này)',
    'group.ungroup.title': 'Hủy nhóm (đưa các LED về Chưa nhóm)',
    'group.ungroup.confirm': 'Hủy nhóm "{g}"? Các LED sẽ trở về trạng thái chưa nhóm.',
    'toast.ungrouped': 'Đã hủy nhóm "{g}"',
    'tree.empty': 'Chưa nạp mô hình',
    'tree.empty.sub': 'Nhập file SketchUp xuất ra (.dae / .obj / .gltf / .fbx) để bắt đầu',
    'led.empty': 'Chưa đánh dấu LED',
    'led.empty.sub': 'Bấm vào đối tượng trong khung 3D hoặc dùng Tự nhận diện',
    'led.remove.title': 'Xóa LED',
    'led.lock.title': 'Khóa / mở khóa',

    'toolbar.select': 'Chọn',
    'toolbar.select.title': 'Chọn LED (V)',
    'toolbar.pan': 'Kéo nền',
    'toolbar.pan.title': 'Kéo nền (H)',
    'toolbar.mapled': 'Mapled',
    'toolbar.mapled.title': 'Di chuyển / co giãn ảnh nền (M)',
    'toolbar.scale': 'Phóng',
    'toolbar.grid': 'Lưới',
    'toolbar.snap': 'Bắt lưới',
    'toolbar.pitch': 'Pixel pitch (mm)',
    'toolbar.autoAlign': 'Đồng bộ 3D',
    'toolbar.autoAlign.title': 'Sắp xếp 2D theo bố cục 3D',
    'toolbar.fitMapled': 'Khớp Mapled',
    'toolbar.fitMapled.title': 'Tự khớp ảnh nền vào vùng các LED đang hoạt động',
    'toolbar.reset': 'Đặt lại',
    'toolbar.undo': 'Hoàn tác',
    'toolbar.undo.title': 'Hoàn tác (Ctrl+Z)',
    'toolbar.opacity': 'Độ mờ',
    'toolbar.preview': 'Xem trước',
    'toolbar.preview.title': 'Chế độ xem trước',
    'toolbar.mask': 'Che',
    'toolbar.mask.title': 'Che vùng ngoài LED',
    'toolbar.activeGroup': 'Nhóm',
    'toolbar.activeGroup.all': 'Tất cả',
    'toolbar.activeGroup.ungrouped': 'Chưa nhóm',
    'toolbar.renameGroup': 'Đổi tên nhóm…',

    '3d.fit': 'Khớp',
    '3d.fit.title': 'Khớp khung nhìn (Space)',
    '3d.grid': 'Lưới',
    '3d.grid.title': 'Bật/tắt lưới',
    '3d.wire': 'Khung dây',
    '3d.wire.title': 'Hiển thị khung dây',
    '3d.overlay': 'Phủ Mapled',
    '3d.overlay.title': 'Phủ Mapled lên các tấm LED 3D',
    '3d.front': 'Trước',
    '3d.top': 'Đỉnh',
    '3d.left': 'Trái',
    '3d.right': 'Phải',
    '3d.iso': 'ISO',

    'hint.3d': '<kbd>Bấm</kbd> đánh dấu LED · <kbd>Ctrl+Bấm</kbd> bật/tắt · <kbd>Shift+Bấm</kbd> thêm chọn · <kbd>Kéo</kbd> xoay · <kbd>Cuộn</kbd> phóng',
    'hint.2d': '<kbd>H</kbd> kéo nền · <kbd>M</kbd> mapled · <kbd>R</kbd> xoay 90° · <kbd>Del</kbd> xóa · <kbd>Cuộn</kbd> phóng',

    'stat.leds': 'Số LED',
    'stat.totalPxW': 'Tổng px W',
    'stat.maxPxH': 'Px H lớn nhất',
    'stat.area': 'Diện tích m²',

    'props.empty': 'Chưa chọn LED',
    'props.empty.sub': 'Chọn một bảng LED ở khung 3D hoặc 2D để chỉnh thuộc tính',
    'props.multi': 'LED đã chọn',
    'props.multi.sub': 'Chọn duy nhất một LED để chỉnh chi tiết',
    'props.identity': 'Định danh',
    'props.name': 'Tên',
    'props.color': 'Màu',
    'props.group': 'Nhóm',
    'props.locked': 'Đã khóa',
    'props.size': 'Kích thước thực',
    'props.width': 'Rộng (mm)',
    'props.height': 'Cao (mm)',
    'props.pixels': 'Pixel',
    'props.pitch': 'Pitch (mm)',
    'props.pixW': 'Px ngang',
    'props.pixH': 'Px dọc',
    'props.pos2d': 'Vị trí 2D (px)',
    'props.rotate': 'Xoay (°)',
    'props.pos3d': 'Vị trí 3D (m)',
    'props.cx': 'Tâm X', 'props.cy': 'Tâm Y', 'props.cz': 'Tâm Z',

    'guide.l1': 'Trong SketchUp, <b>đặt tên nhóm LED</b> bắt đầu bằng "LED" rồi xuất ra <code>.dae</code> hoặc <code>.gltf</code> để mở tại đây.',
    'guide.l2': 'Bấm vào nhóm hoặc mesh trong khung 3D để đánh dấu. Bấm vào <b>nhóm có tên LED</b> để đánh dấu cả cụm. Dùng <b>Tự nhận diện</b> cho nhanh.',
    'guide.l3': 'Chuyển sang <b>Mapping 2D</b>, tải ảnh/video tham chiếu, sau đó chọn nhóm và kéo các bảng cho khớp.',
    'guide.l4': 'Bật <b>Xem trước</b> để xem video ánh xạ lên LED. <b>Lưu</b> dự án (Ctrl+S) để dùng lại lần sau.',

    'status.ready': 'Sẵn sàng. Mở mô hình 3D để bắt đầu.',
    'status.mode': 'Chế độ',
    'status.mode.3d': '3D',
    'status.mode.2d': 'Mapping 2D',

    'toast.loaded': 'Đã nạp',
    'toast.aligned': 'Đã đồng bộ vị trí 2D theo bố cục 3D',
    'toast.fitted': 'Đã khớp Mapled với vùng các LED',
    'toast.noLeds': 'Chưa có LED để sắp xếp',
    'toast.import3dFirst': 'Hãy nhập mô hình 3D trước',
    'toast.detected': 'Đã tự nhận diện {n} bảng LED',
    'toast.detected.none': 'Không tìm thấy LED theo tên hoặc kích thước. Hãy bấm thủ công vào các bảng trong khung 3D.',
    'toast.confirmClear': 'Xóa toàn bộ đánh dấu LED?',
    'toast.frozen': 'Đã khóa toàn bộ LED',
    'toast.unfrozen': 'Đã mở khóa toàn bộ LED',
    'toast.locked': 'Đã khóa LED',
    'toast.unlocked': 'Đã mở khóa LED',
    'toast.grouped': 'Đã gán {n} LED vào nhóm "{g}"',
    'toast.noSelection': 'Chưa chọn LED nào',
    'toast.langChanged': 'Đã chuyển sang Tiếng Việt',
    'toast.nothingUndo': 'Không có gì để hoàn tác',
    'toast.undid': 'Đã hoàn tác: {label}',
    'toast.imageLoaded': 'Đã nạp ảnh ({w}×{h})',
    'toast.videoLoaded': 'Đã nạp video ({w}×{h}, {time})',
    'toast.unsupported': 'Định dạng không hỗ trợ',
    'toast.savedProject': 'Đã tải "{file}" về Downloads. Chuyển vào thư mục /saves/ trong repo để giữ lại.',
    'toast.openedProject': 'Đã mở "{name}". Tải lại ảnh/video nếu cần.',
    'toast.invalidProject': 'File dự án không hợp lệ',
    'toast.openFailed': 'Không thể mở dự án: {err}',
    'toast.saveFailed': 'Không thể lưu: {err}',
    'prompt.projectName': 'Tên dự án:',
    'prompt.nameEmpty': 'Tên không được để trống',

    'prompt.groupName': 'Tên nhóm LED:',
    'prompt.renameGroup': 'Tên nhóm mới:',
  },

  en: {
    'app.title': 'Stage LED Mapping',
    'app.subtitle': '◆ Felic Studio · 3D → 2D',

    'topbar.openModel': 'Open 3D Model',
    'topbar.openModel.title': 'Import 3D model (.gltf, .glb, .obj, .dae, .fbx)',
    'topbar.mapled': 'Mapled / Video',
    'topbar.mapled.title': 'Load mapled reference (image or video)',
    'topbar.mode3d': '3D View',
    'topbar.mode2d': '2D Mapping',
    'topbar.save': 'Save',
    'topbar.save.title': 'Save project (Ctrl+S)',
    'topbar.open': 'Projects',
    'topbar.open.title': 'Open project (Ctrl+O)',
    'topbar.freezeAll': 'Freeze all',
    'topbar.unfreezeAll': 'Unfreeze all',
    'topbar.freezeAll.title': 'Lock or unlock every LED',
    'topbar.lang.title': 'Switch language',
    'video.play': 'Play',
    'video.pause': 'Pause',

    'panel.objects': '◆ Object Hierarchy',
    'panel.leds': '◆ LED Panels',
    'panel.props': '◆ Properties',
    'panel.overview': '◆ Project Overview',
    'panel.guide': '◆ Quick Guide',

    'search.objects': 'Search by name…',
    'btn.autodetect': 'Auto-detect LEDs',
    'btn.clearAll': 'Clear all',
    'btn.groupSelected': 'Group selected',
    'btn.groupSelected.title': 'Assign currently-selected LEDs to a group',
    'group.lock.title': 'Lock entire group',
    'group.unlock.title': 'Unlock entire group',
    'group.overlay.show.title': 'Show mapled overlay (hides this group’s LED panels)',
    'group.overlay.hide.title': 'Hide mapled overlay (shows this group’s LED panels)',
    'group.ungroup.title': 'Ungroup (move LEDs back to Ungrouped)',
    'group.ungroup.confirm': 'Ungroup "{g}"? Its LEDs will return to the Ungrouped bucket.',
    'toast.ungrouped': 'Ungrouped "{g}"',
    'tree.empty': 'No model loaded',
    'tree.empty.sub': 'Import a SketchUp export (.dae / .obj / .gltf / .fbx) to begin',
    'led.empty': 'No LED panels marked',
    'led.empty.sub': 'Click objects in the 3D view or use Auto-detect',
    'led.remove.title': 'Remove LED',
    'led.lock.title': 'Lock / unlock',

    'toolbar.select': 'Select',
    'toolbar.select.title': 'Select LEDs (V)',
    'toolbar.pan': 'Pan',
    'toolbar.pan.title': 'Pan (H)',
    'toolbar.mapled': 'Mapled',
    'toolbar.mapled.title': 'Move / scale the mapled (M)',
    'toolbar.scale': 'Scale',
    'toolbar.grid': 'Grid',
    'toolbar.snap': 'Snap',
    'toolbar.pitch': 'Pixel pitch (mm)',
    'toolbar.autoAlign': 'Auto-align',
    'toolbar.autoAlign.title': 'Align 2D positions from 3D layout',
    'toolbar.fitMapled': 'Fit mapled',
    'toolbar.fitMapled.title': 'Auto-fit the mapled to the active group LEDs',
    'toolbar.reset': 'Reset',
    'toolbar.undo': 'Undo',
    'toolbar.undo.title': 'Undo (Ctrl+Z)',
    'toolbar.opacity': 'Opacity',
    'toolbar.preview': 'Preview',
    'toolbar.preview.title': 'Preview mode',
    'toolbar.mask': 'Mask',
    'toolbar.mask.title': 'Mask outside LEDs',
    'toolbar.activeGroup': 'Group',
    'toolbar.activeGroup.all': 'All',
    'toolbar.activeGroup.ungrouped': 'Ungrouped',
    'toolbar.renameGroup': 'Rename group…',

    '3d.fit': 'Fit',
    '3d.fit.title': 'Fit view (Space)',
    '3d.grid': 'Grid',
    '3d.grid.title': 'Toggle grid',
    '3d.wire': 'Wire',
    '3d.wire.title': 'Wireframe',
    '3d.overlay': 'Mapled overlay',
    '3d.overlay.title': 'Project mapled onto 3D LED panels',
    '3d.front': 'F', '3d.top': 'T', '3d.left': 'L', '3d.right': 'R', '3d.iso': 'ISO',

    'hint.3d': '<kbd>Click</kbd> mark LED · <kbd>Ctrl+Click</kbd> toggle · <kbd>Shift+Click</kbd> add · <kbd>Drag</kbd> orbit · <kbd>Scroll</kbd> zoom',
    'hint.2d': '<kbd>H</kbd> pan · <kbd>M</kbd> mapled · <kbd>R</kbd> rotate 90° · <kbd>Del</kbd> remove · <kbd>Scroll</kbd> zoom',

    'stat.leds': 'LED Panels',
    'stat.totalPxW': 'Total px W',
    'stat.maxPxH': 'Max px H',
    'stat.area': 'Area m²',

    'props.empty': 'No LED selected',
    'props.empty.sub': 'Select a panel in the 3D or 2D view to edit its properties',
    'props.multi': 'LEDs selected',
    'props.multi.sub': 'Select a single LED to edit properties',
    'props.identity': 'Identity',
    'props.name': 'Name',
    'props.color': 'Color',
    'props.group': 'Group',
    'props.locked': 'Locked',
    'props.size': 'Physical size',
    'props.width': 'Width (mm)',
    'props.height': 'Height (mm)',
    'props.pixels': 'Pixels',
    'props.pitch': 'Pitch (mm)',
    'props.pixW': 'Pixel W',
    'props.pixH': 'Pixel H',
    'props.pos2d': '2D position (px)',
    'props.rotate': 'Rotate (°)',
    'props.pos3d': '3D position (m)',
    'props.cx': 'Center X', 'props.cy': 'Center Y', 'props.cz': 'Center Z',

    'guide.l1': 'In SketchUp, <b>name your LED groups</b> "LED" then export as <code>.dae</code> or <code>.gltf</code> and open here.',
    'guide.l2': 'Click any group or mesh in the 3D view to mark it. Click a <b>LED-named group</b> to mark all panels inside at once. Use <b>Auto-detect</b> for quick detection.',
    'guide.l3': 'Switch to <b>2D Mapping</b>, load a <b>Mapled</b> reference image or video, then drag panels to match.',
    'guide.l4': 'Use <b>Preview</b> to see video mapped onto LEDs. <b>Save</b> your project (Ctrl+S) to resume later.',

    'status.ready': 'Ready. Open a 3D model to begin.',
    'status.mode': 'Mode',
    'status.mode.3d': '3D',
    'status.mode.2d': '2D Mapping',

    'toast.loaded': 'Loaded',
    'toast.aligned': 'Aligned 2D positions from 3D layout',
    'toast.fitted': 'Fitted mapled to LED area',
    'toast.noLeds': 'No LEDs to arrange',
    'toast.import3dFirst': 'Import a 3D model first',
    'toast.detected': 'Auto-detected {n} LED panels',
    'toast.detected.none': 'No LED objects found by name or size. Click panels manually in the 3D view.',
    'toast.confirmClear': 'Remove all LED marks?',
    'toast.frozen': 'All LEDs frozen',
    'toast.unfrozen': 'All LEDs unlocked',
    'toast.locked': 'LED locked',
    'toast.unlocked': 'LED unlocked',
    'toast.grouped': 'Grouped {n} LEDs into "{g}"',
    'toast.noSelection': 'No LEDs selected',
    'toast.langChanged': 'Switched to English',
    'toast.nothingUndo': 'Nothing to undo',
    'toast.undid': 'Undid: {label}',
    'toast.imageLoaded': 'Mapled loaded ({w}×{h})',
    'toast.videoLoaded': 'Video loaded ({w}×{h}, {time})',
    'toast.unsupported': 'Unsupported file format',
    'toast.savedProject': 'Saved "{file}" to Downloads. Move it to /saves/ in the repo to keep it.',
    'toast.openedProject': 'Opened "{name}". Reload the mapled image/video if needed.',
    'toast.invalidProject': 'Not a valid project file',
    'toast.openFailed': 'Could not open project: {err}',
    'toast.saveFailed': 'Could not save: {err}',
    'prompt.projectName': 'Project name:',
    'prompt.nameEmpty': 'Name cannot be empty',

    'prompt.groupName': 'LED group name:',
    'prompt.renameGroup': 'New group name:',
  },
};

class I18n extends EventTarget {
  constructor() {
    super();
    const saved = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } })();
    this.lang = (saved === 'en' || saved === 'vi') ? saved : 'vi';
  }

  setLang(lang) {
    if (lang !== 'vi' && lang !== 'en') return;
    if (lang === this.lang) return;
    this.lang = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
    document.documentElement.setAttribute('lang', lang);
    this.applyTo(document);
    this.dispatchEvent(new CustomEvent('change', { detail: lang }));
  }

  toggle() { this.setLang(this.lang === 'vi' ? 'en' : 'vi'); }

  t(key, params) {
    const dict = DICT[this.lang] || DICT.vi;
    let s = dict[key];
    if (s == null) s = DICT.vi[key] ?? key;
    if (params) {
      for (const k of Object.keys(params)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), params[k]);
      }
    }
    return s;
  }

  applyTo(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = this.t(key);
      // If the key contains HTML tags (kbd, b, code…), use innerHTML, otherwise textContent.
      if (/<[a-z]/i.test(val)) el.innerHTML = val;
      else el.textContent = val;
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = this.t(el.getAttribute('data-i18n-title'));
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(el => {
      // Format: "attrName:key" — multiple separated by ';'
      el.getAttribute('data-i18n-attr').split(';').forEach(pair => {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (attr && key) el.setAttribute(attr, this.t(key));
      });
    });
  }
}

export const i18n = new I18n();
export const t = (k, p) => i18n.t(k, p);
