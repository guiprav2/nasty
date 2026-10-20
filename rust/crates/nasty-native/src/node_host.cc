#include <android/native_activity.h>
#include <dlfcn.h>
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

