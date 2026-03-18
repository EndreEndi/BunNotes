/**
 * Expo config plugin — injects a native Android home screen widget.
 *
 * The widget shows a record button. Tapping it launches WhisperNotes
 * and immediately starts recording. Works on regular home screen
 * AND the Motorola RAZR external display widget panel.
 */
const {
  withAndroidManifest,
  withDangerousMod,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PACKAGE = 'com.eendi.bunnotes';
const PACKAGE_DIR = 'com/eendi/bunnotes';

// ---------------------------------------------------------------------------
// Widget provider Kotlin source
// ---------------------------------------------------------------------------
const WIDGET_PROVIDER_KT = `
package ${PACKAGE}.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import ${PACKAGE}.MainActivity
import ${PACKAGE}.R

class RecordWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (widgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, widgetId)
        }
    }

    companion object {
        fun updateWidget(
            context: Context,
            appWidgetManager: AppWidgetManager,
            widgetId: Int
        ) {
            // Deep link: handled by Expo Linking API in JS
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("bunnotes://record")).apply {
                setPackage(context.packageName)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val pending = PendingIntent.getActivity(
                context, widgetId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val views = RemoteViews(context.packageName, R.layout.widget_record)
            views.setOnClickPendingIntent(R.id.widget_record_btn, pending)
            appWidgetManager.updateAppWidget(widgetId, views)
        }
    }
}
`;

// ---------------------------------------------------------------------------
// Widget layout XML
// ---------------------------------------------------------------------------
const WIDGET_LAYOUT_XML = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout
    xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:gravity="center"
    android:background="@android:color/transparent"
    android:padding="4dp">

    <ImageView
        android:id="@+id/widget_record_btn"
        android:layout_width="64dp"
        android:layout_height="64dp"
        android:src="@drawable/widget_record_icon"
        android:contentDescription="Record voice note"
        android:scaleType="fitCenter" />

</LinearLayout>
`;

// ---------------------------------------------------------------------------
// Widget record icon (vector drawable — red circle with mic shape)
// ---------------------------------------------------------------------------
const WIDGET_ICON_XML = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="64dp"
    android:height="64dp"
    android:viewportWidth="64"
    android:viewportHeight="64">

    <!-- Outer ring -->
    <path
        android:fillColor="#00000000"
        android:strokeColor="#FF3B5C"
        android:strokeWidth="3"
        android:pathData="M32,32m-28,0a28,28 0,1 1,56 0a28,28 0,1 1,-56 0"/>

    <!-- Inner filled circle -->
    <path
        android:fillColor="#FF3B5C"
        android:pathData="M32,32m-14,0a14,14 0,1 1,28 0a14,14 0,1 1,-28 0"/>

</vector>
`;

// ---------------------------------------------------------------------------
// Widget info XML (metadata for the widget picker)
// ---------------------------------------------------------------------------
const WIDGET_INFO_XML = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="72dp"
    android:minHeight="72dp"
    android:targetCellWidth="1"
    android:targetCellHeight="1"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/widget_record"
    android:resizeMode="none"
    android:widgetCategory="home_screen"
    android:previewLayout="@layout/widget_record"
    android:description="@string/widget_description" />
`;

// ---------------------------------------------------------------------------
// Helper: ensure directory exists and write file
// ---------------------------------------------------------------------------
function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.trim() + '\n');
}

// ---------------------------------------------------------------------------
// Plugin: inject native files
// ---------------------------------------------------------------------------
function withRecordWidget(config) {
  // Step 1: Add widget receiver to AndroidManifest
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults;
    const app = manifest.manifest.application[0];

    // Add receiver for the widget
    if (!app.receiver) app.receiver = [];

    const alreadyAdded = app.receiver.some(
      r => r.$?.['android:name'] === '.widget.RecordWidgetProvider'
    );

    if (!alreadyAdded) {
      app.receiver.push({
        $: {
          'android:name': '.widget.RecordWidgetProvider',
          'android:exported': 'true',
        },
        'intent-filter': [{
          action: [{
            $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' },
          }],
        }],
        'meta-data': [{
          $: {
            'android:name': 'android.appwidget.provider',
            'android:resource': '@xml/widget_record_info',
          },
        }],
      });
    }

    return mod;
  });

  // Step 2: Write native source files
  config = withDangerousMod(config, [
    'android',
    (mod) => {
      const projectRoot = mod.modRequest.platformProjectRoot;

      // Kotlin source
      writeFile(
        path.join(projectRoot, 'app/src/main/java', PACKAGE_DIR, 'widget/RecordWidgetProvider.kt'),
        WIDGET_PROVIDER_KT
      );

      // Layout XML
      writeFile(
        path.join(projectRoot, 'app/src/main/res/layout/widget_record.xml'),
        WIDGET_LAYOUT_XML
      );

      // Drawable icon
      writeFile(
        path.join(projectRoot, 'app/src/main/res/drawable/widget_record_icon.xml'),
        WIDGET_ICON_XML
      );

      // Widget info XML
      writeFile(
        path.join(projectRoot, 'app/src/main/res/xml/widget_record_info.xml'),
        WIDGET_INFO_XML
      );

      // String resource for widget description
      const stringsPath = path.join(projectRoot, 'app/src/main/res/values/widget_strings.xml');
      writeFile(stringsPath, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="widget_description">Quick record voice note</string>
</resources>`);

      return mod;
    },
  ]);

  return config;
}

module.exports = withRecordWidget;
