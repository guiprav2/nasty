#include <android/native_activity.h>
#include <dlfcn.h>
#include <cstdlib>
#include <cstring>
#include <jni.h>
#include <node.h>

namespace {
JavaVM *g_vm = nullptr;
jobject g_activity = nullptr;
}

extern "C" void nasty_set_android_activity(void *java_vm_pointer,
                                             void *activity_pointer) {
  auto *vm = static_cast<JavaVM *>(java_vm_pointer);
  auto activity = static_cast<jobject>(activity_pointer);
  if (vm == nullptr || activity == nullptr) return;
  JNIEnv *env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK ||
      env == nullptr) return;
  g_vm = vm;
  g_activity = env->NewGlobalRef(activity);
}

extern "C" int nasty_set_requested_orientation(int orientation) {
  if (g_vm == nullptr || g_activity == nullptr) return -1;
  JNIEnv *env = nullptr;
  bool attached = false;
  const jint status = g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
  if (status == JNI_EDETACHED) {
    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return -2;
    attached = true;
  } else if (status != JNI_OK) {
    return -3;
  }

  jclass activity_class = env->GetObjectClass(g_activity);
  jmethodID set_orientation = activity_class == nullptr
      ? nullptr
      : env->GetMethodID(activity_class, "setRequestedOrientation", "(I)V");
  if (set_orientation != nullptr) {
    env->CallVoidMethod(g_activity, set_orientation, static_cast<jint>(orientation));
  }
  const bool failed = set_orientation == nullptr || env->ExceptionCheck();
  if (failed) env->ExceptionClear();
  if (activity_class != nullptr) env->DeleteLocalRef(activity_class);
  if (attached) g_vm->DetachCurrentThread();
  return failed ? -4 : 0;
}

// Fullscreen on Android: NastyActivity.nastySetImmersive hides (or restores) the system bars.
// Returns 1 when the activity has no such method (a plain NativeActivity).
extern "C" int nasty_set_immersive(int immersive) {
  if (g_vm == nullptr || g_activity == nullptr) return -1;
  JNIEnv *env = nullptr;
  bool attached = false;
  const jint status = g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
  if (status == JNI_EDETACHED) {
    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return -2;
    attached = true;
  } else if (status != JNI_OK) {
    return -3;
  }
  int result = 0;
  jclass activity_class = env->GetObjectClass(g_activity);
  jmethodID method = activity_class == nullptr ? nullptr : env->GetMethodID(activity_class, "nastySetImmersive", "(Z)V");
  if (method == nullptr) {
    env->ExceptionClear();
    result = 1;
  } else {
    env->CallVoidMethod(g_activity, method, static_cast<jboolean>(immersive != 0));
    if (env->ExceptionCheck()) { env->ExceptionClear(); result = -4; }
  }
  if (activity_class != nullptr) env->DeleteLocalRef(activity_class);
  if (attached) g_vm->DetachCurrentThread();
  return result;
}

// Android's default for an unhandled back press: send the app to the background
// (Activity.moveTaskToBack), keeping it running like other apps do.
extern "C" int nasty_move_task_to_back() {
  if (g_vm == nullptr || g_activity == nullptr) return -1;
  JNIEnv *env = nullptr;
  bool attached = false;
  const jint status = g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
  if (status == JNI_EDETACHED) {
    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return -2;
    attached = true;
  } else if (status != JNI_OK) {
    return -3;
  }
  jclass activity_class = env->GetObjectClass(g_activity);
  jmethodID move = activity_class == nullptr ? nullptr : env->GetMethodID(activity_class, "moveTaskToBack", "(Z)Z");
  if (move != nullptr) env->CallBooleanMethod(g_activity, move, JNI_TRUE);
  const bool failed = move == nullptr || env->ExceptionCheck();
  if (failed) env->ExceptionClear();
  if (activity_class != nullptr) env->DeleteLocalRef(activity_class);
  if (attached) g_vm->DetachCurrentThread();
  return failed ? -4 : 0;
}

// Vitrola's APK embeds yt-dlp in a Python runtime; its activity exposes
// String nastyYtdlpExtractInfo(String source, boolean flat). Returns a malloc'd
// UTF-8 string: the info JSON with *ok = 1, or an error message with *ok = 0.
// Free it with nasty_free_string.
extern "C" char *nasty_ytdlp_extract(const char *source, int flat, int *ok) {
  *ok = 0;
  if (g_vm == nullptr || g_activity == nullptr) return strdup("yt-dlp: Android activity not initialized");
  JNIEnv *env = nullptr;
  bool attached = false;
  const jint status = g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
  if (status == JNI_EDETACHED) {
    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return strdup("yt-dlp: couldn't attach to the JVM");
    attached = true;
  } else if (status != JNI_OK) {
    return strdup("yt-dlp: no JNI environment");
  }

  char *result = nullptr;
  jclass activity_class = env->GetObjectClass(g_activity);
  jmethodID extract = activity_class == nullptr
      ? nullptr
      : env->GetMethodID(activity_class, "nastyYtdlpExtractInfo", "(Ljava/lang/String;Z)Ljava/lang/String;");
  if (extract == nullptr) {
    env->ExceptionClear();
    result = strdup("yt-dlp isn't bundled in this APK");
  } else {
    jstring jsource = env->NewStringUTF(source);
    auto value = static_cast<jstring>(env->CallObjectMethod(g_activity, extract, jsource, static_cast<jboolean>(flat != 0)));
    if (jthrowable error = env->ExceptionOccurred()) {
      env->ExceptionClear();
      jclass throwable = env->FindClass("java/lang/Throwable");
      jmethodID to_string = env->GetMethodID(throwable, "toString", "()Ljava/lang/String;");
      auto message = static_cast<jstring>(env->CallObjectMethod(error, to_string));
      if (env->ExceptionCheck() || message == nullptr) {
        env->ExceptionClear();
        result = strdup("yt-dlp failed");
      } else {
        const char *chars = env->GetStringUTFChars(message, nullptr);
        result = strdup(chars);
        env->ReleaseStringUTFChars(message, chars);
        env->DeleteLocalRef(message);
      }
      env->DeleteLocalRef(throwable);
      env->DeleteLocalRef(error);
    } else if (value == nullptr) {
      result = strdup("yt-dlp returned nothing");
    } else {
      const char *chars = env->GetStringUTFChars(value, nullptr);
      result = strdup(chars);
      env->ReleaseStringUTFChars(value, chars);
      *ok = 1;
    }
    if (value != nullptr) env->DeleteLocalRef(value);
    env->DeleteLocalRef(jsource);
  }
  if (activity_class != nullptr) env->DeleteLocalRef(activity_class);
  if (attached) g_vm->DetachCurrentThread();
  return result;
}

extern "C" void nasty_free_string(char *value) { free(value); }

namespace {
bool g_camera_requested = false;
bool g_camera_rationale_at_request = false;

bool camera_rationale(JNIEnv *env, jclass activity_class, jstring permission) {
  jmethodID method = env->GetMethodID(activity_class, "shouldShowRequestPermissionRationale",
                                      "(Ljava/lang/String;)Z");
  if (method == nullptr) { env->ExceptionClear(); return false; }
  const bool value = env->CallBooleanMethod(g_activity, method, permission);
  if (env->ExceptionCheck()) { env->ExceptionClear(); return false; }
  return value;
}
}  // namespace

// 1 = granted, 2 = refused after this process asked, 0 = not decided yet.
// NativeActivity receives no permission-result callback, so callers poll.
extern "C" int nasty_camera_permission(int request) {
  if (g_vm == nullptr || g_activity == nullptr) return 0;
  JNIEnv *env = nullptr;
  bool attached = false;
  const jint status = g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
  if (status == JNI_EDETACHED) {
    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return 0;
    attached = true;
  } else if (status != JNI_OK) {
    return 0;
  }
  int result = 0;
  jstring permission = env->NewStringUTF("android.permission.CAMERA");
  jclass activity_class = env->GetObjectClass(g_activity);
  jmethodID check = env->GetMethodID(activity_class, "checkSelfPermission", "(Ljava/lang/String;)I");
  jint granted = -1;
  if (check != nullptr) granted = env->CallIntMethod(g_activity, check, permission);
  if (env->ExceptionCheck()) { env->ExceptionClear(); granted = -1; }
  if (granted == 0) {
    result = 1;
  } else if (g_camera_requested) {
    if (camera_rationale(env, activity_class, permission) != g_camera_rationale_at_request) result = 2;
  } else if (request) {
    g_camera_rationale_at_request = camera_rationale(env, activity_class, permission);
    jclass string_class = env->FindClass("java/lang/String");
    jobjectArray permissions = env->NewObjectArray(1, string_class, permission);
    jmethodID ask = env->GetMethodID(activity_class, "requestPermissions", "([Ljava/lang/String;I)V");
    if (ask != nullptr) env->CallVoidMethod(g_activity, ask, permissions, static_cast<jint>(7));
    if (env->ExceptionCheck()) env->ExceptionClear();
    else g_camera_requested = true;
    env->DeleteLocalRef(permissions);
    env->DeleteLocalRef(string_class);
  }
  env->DeleteLocalRef(activity_class);
  env->DeleteLocalRef(permission);
  if (attached) g_vm->DetachCurrentThread();
  return result;
}

extern "C" int nasty_node_start(const char *script_path) {
  char *argv[] = {const_cast<char *>("node"), const_cast<char *>(script_path)};
  return node::Start(2, argv);
}

extern "C" const char *nasty_native_library_path() {
  static const char *path = nullptr;
  if (path != nullptr) return path;
  Dl_info info{};
  if (dladdr(reinterpret_cast<void *>(&nasty_native_library_path), &info) == 0) return nullptr;
  path = info.dli_fname;
  return path;
}

