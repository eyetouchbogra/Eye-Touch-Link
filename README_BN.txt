আই টাচৃ লিংক | Eye Touch Link — Offline হিসাব অ্যাপ v1.2

Windows PC:
1. ZIP ফাইল Extract All করুন।
2. index.html Chrome/Edge-এ খুলুন।
3. ডেস্কটপ আইকনের জন্য Chrome/Edge menu → Create shortcut বা Install app ব্যবহার করুন।

Android ও PC-তে অ্যাপের মতো Home Screen icon:
PWA install করতে ফাইলগুলো HTTPS ওয়েব হোস্টিংয়ে রাখতে হবে। এরপর Chrome/Edge-এ ঠিকানা খুলে Android-এ Add to Home screen/Install app এবং Windows-এ Install app/Create shortcut নির্বাচন করুন।

PIN লক:
Settings → PIN সেট / পরিবর্তন থেকে ৪–৮ সংখ্যার PIN সেট করুন। পরেরবার অ্যাপ খুললে PIN চাইবে। PIN বন্ধ করতে বর্তমান PIN দিতে হবে। PIN ভুলে গেলে সহজে পুনরুদ্ধারের ব্যবস্থা নেই; ব্রাউজারের ডেটা মুছে PIN সরালে স্থানীয় হিসাবও মুছে যেতে পারে—তাই আগে JSON ব্যাকআপ নিন।

ফিচার: আয়/খরচ, ব্যক্তিগত/ব্যবসা আলাদা, ধার-দেনা, মাসিক রিপোর্ট, CSV export, Print → Save as PDF, JSON backup/restore, বাংলা/English toggle, PIN lock.

গুরুত্বপূর্ণ সীমাবদ্ধতা:
- PIN লক সাধারণ গোপনীয়তার স্তর; এটি ডেটা এনক্রিপশন নয়।
- হিসাব একই ব্রাউজারের localStorage-এ থাকে; Windows/Android auto-sync নেই।
- ব্রাউজারের data clear হলে হিসাব হারাতে পারেন; নিয়মিত JSON backup নিন।
- এটি এখনো native APK/EXE installer নয়।
