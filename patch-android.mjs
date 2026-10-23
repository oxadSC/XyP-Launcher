// Дописывает в AndroidManifest.xml то, что нужно лаунчеру:
//  - разрешение на установку .apk
//  - видимость пакета Minecraft и схемы minecraft:// (обязательно на Android 11+)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const file = 'android/app/src/main/AndroidManifest.xml';
if (!existsSync(file)) {
  console.error('Не найден ' + file + '. Сначала выполните: npx cap add android');
  process.exit(1);
}
let xml = readFileSync(file, 'utf8');

if (xml.includes('REQUEST_INSTALL_PACKAGES')) {
  console.log('Манифест уже исправлен.');
  process.exit(0);
}

const block = `
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />

    <queries>
        <package android:name="com.mojang.minecraftpe" />
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="minecraft" />
        </intent>
    </queries>

    `;

if (!xml.includes('<application')) {
  console.error('В манифесте нет тега <application>.');
  process.exit(1);
}
xml = xml.replace('<application', block + '<application');
writeFileSync(file, xml);
console.log('Манифест Android обновлён.');
