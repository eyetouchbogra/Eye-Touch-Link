
async function refreshDevices() {
  const el = $('cloudDeviceList');
  const btn = $('cloudRefreshDevices');

  if (!el) return;

  if (!client) {
    el.textContent = 'Cloud সংযোগ প্রস্তুত হয়নি।';
    return;
  }

  if (!approved) {
    el.textContent = 'এই ডিভাইসের অনুমোদন যাচাই হয়নি।';
    return;
  }

  const oldText = btn?.textContent;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'তালিকা আনা হচ্ছে...';
  }

  el.textContent = 'ডিভাইস তালিকা আনা হচ্ছে...';

  try {
    const rows = await rpc('etl_list_devices', {
      p_actor_device_id: deviceId
    });

    el.innerHTML = rows.map(d => `
      <div class="device-row">
        <div class="device-meta">
          <b>${escapeHtml(d.device_name)}
            ${d.device_id === deviceId ? '(এই ডিভাইস)' : ''}
          </b>
          <small>
            ${escapeHtml(d.platform)} · ${escapeHtml(d.status)}
            · শেষ ব্যবহার:
            ${d.last_seen_at
              ? new Date(d.last_seen_at).toLocaleString()
              : '—'}
          </small>
        </div>
        <div class="device-actions">
          ${d.status === 'pending'
            ? `<button class="primary"
                 data-approve-device="${escapeHtml(d.device_id)}">
                 অনুমোদন
               </button>`
            : ''}
          ${d.status === 'approved' && d.device_id !== deviceId
            ? `<button class="danger"
                 data-revoke-device="${escapeHtml(d.device_id)}">
                 প্রবেশ বাতিল
               </button>`
            : ''}
        </div>
      </div>
    `).join('') || '<div class="empty">কোনো ডিভাইস নেই।</div>';

    el.querySelectorAll('[data-approve-device]').forEach(b => {
      b.onclick = async () => {
        try {
          const ok = await rpc('etl_approve_device', {
            p_actor_device_id: deviceId,
            p_target_device_id: b.dataset.approveDevice
          });
          await refreshDevices();
          alert(
            ok
              ? 'ডিভাইস অনুমোদিত হয়েছে। নতুন ডিভাইসে “আবার যাচাই করুন” চাপুন।'
              : 'ডিভাইস অনুমোদন করা যায়নি; তালিকা রিফ্রেশ করুন।'
          );
        } catch (e) {
          alert(e.message);
        }
      };
    });

    el.querySelectorAll('[data-revoke-device]').forEach(b => {
      b.onclick = async () => {
        if (!confirm('এই ডিভাইসের Cloud প্রবেশাধিকার বাতিল করবেন?')) return;

        try {
          await rpc('etl_revoke_device', {
            p_actor_device_id: deviceId,
            p_target_device_id: b.dataset.revokeDevice
          });
          await refreshDevices();
        } catch (e) {
          alert(e.message);
        }
      };
    });

  } catch (e) {
    el.textContent = 'ডিভাইস তালিকা পাওয়া যায়নি: ' + e.message;
    status('ডিভাইস তালিকা রিফ্রেশ ব্যর্থ: ' + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || 'ডিভাইস তালিকা রিফ্রেশ';
    }
  }
}
