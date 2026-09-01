/*
 * cdn_fetch.c — CDN 直取注入器（ptrace 借线程远程调用，零 hook 零 frida）
 *
 * 机制：PTRACE_ATTACH 微信一个空闲线程 → 远程 mmap → 写入 param（libc++ long-form
 * string + 假回调 vtable 全 stub）→ 劫持线程上下文调用 cdn_logic::StartC2CDownload
 * → 恢复现场 DETACH。任务由微信 CDN 线程异步完成（apply 鉴权 + 下载 + aeskey 解密），
 * 明文落盘 savePath。PoC 已端到端验证（2026-09-01，CDN-DIRECT-FETCH-POC-FINAL.md）。
 *
 * 硬约束（PoC 教训，勿回退）：
 *   1. base 必须取模块最低地址映射段（ELF load base），取 r-x 段会偏移数十 MB；
 *   2. param 页不可在调用后回收——任务异步寿命远长于调用（v2.1 munmap 致 UAF 闪退）；
 *      每次调用泄漏 64KB，由调用方限流兜底，微信进程重启自然清零；
 *   3. wechat md5 硬守卫：RVA 绑定 4.1.1.8（ddf942dd...），版本不符拒绝执行；
 *   4. ret=-32767 表示 CDN 子系统懒初始化未完成，调用方等首个媒体事件后重试。
 *
 * 用法：cdn_fetch <fileKey_hex> <aesKey> <fileLen> <savePath> [taskname] [--probe]
 * 输出：单行 JSON {"success":true,"ret":0} / {"success":false,"error":"..."}
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <errno.h>
#include <dirent.h>
#include <signal.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/user.h>

#define RVA_START_C2C 0x6A6F4A0ULL
#define WECHAT_MD5    "ddf942dd09f806161b5d40b0084a55e3"
#define WECHAT_PATH   "/opt/wechat/wechat"

/* ── 紧凑 MD5（RFC 1321，仅用于 wechat 版本守卫） ── */
static const uint32_t MD5K[64] = {
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
    0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
    0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
    0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391
};
static const int MD5S[64] = {
    7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
    5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
    6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21
};
typedef struct { uint32_t a, b, c, d; uint64_t total; unsigned char buf[64]; size_t blen; } md5_ctx;

static uint32_t rotl32(uint32_t v, int s) { return (v << s) | (v >> (32 - s)); }

static void md5_transform(uint32_t st[4], const unsigned char blk[64]) {
    uint32_t m[16], a = st[0], b = st[1], c = st[2], d = st[3];
    for (int i = 0; i < 16; i++)
        m[i] = (uint32_t)blk[i*4] | ((uint32_t)blk[i*4+1] << 8) |
               ((uint32_t)blk[i*4+2] << 16) | ((uint32_t)blk[i*4+3] << 24);
    for (int i = 0; i < 64; i++) {
        uint32_t f; int g;
        if (i < 16)      { f = (b & c) | (~b & d);        g = i; }
        else if (i < 32) { f = (d & b) | (~d & c);        g = (5*i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d;                 g = (3*i + 5) % 16; }
        else             { f = c ^ (b | ~d);              g = (7*i) % 16; }
        uint32_t tmp = d; d = c; c = b;
        b = b + rotl32(a + f + MD5K[i] + m[g], MD5S[i]);
        a = tmp;
    }
    st[0] += a; st[1] += b; st[2] += c; st[3] += d;
}

static void md5_update(md5_ctx *x, const unsigned char *data, size_t len) {
    x->total += len;
    while (len) {
        size_t take = 64 - x->blen < len ? 64 - x->blen : len;
        memcpy(x->buf + x->blen, data, take);
        x->blen += take; data += take; len -= take;
        if (x->blen == 64) { md5_transform((uint32_t *)x, x->buf); x->blen = 0; }
    }
}

static void md5_final(md5_ctx *x, unsigned char out[16]) {
    uint64_t bits = x->total * 8;
    unsigned char pad = 0x80;
    md5_update(x, &pad, 1);
    unsigned char z = 0;
    while (x->blen != 56) md5_update(x, &z, 1);
    unsigned char tail[8];
    for (int i = 0; i < 8; i++) tail[i] = (unsigned char)(bits >> (8*i));
    md5_update(x, tail, 8);
    unsigned char digest[16];
    memcpy(digest, &x->a, 4); memcpy(digest + 4, &x->b, 4);
    memcpy(digest + 8, &x->c, 4); memcpy(digest + 12, &x->d, 4);
    memcpy(out, digest, 16);
}

static int md5_file(const char *path, char hex[33]) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    md5_ctx x; x.a = 0x67452301; x.b = 0xefcdab89; x.c = 0x98badcfe; x.d = 0x10325476;
    x.total = 0; x.blen = 0;
    unsigned char buf[65536], digest[16];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) md5_update(&x, buf, n);
    fclose(f);
    md5_final(&x, digest);
    for (int i = 0; i < 16; i++) sprintf(hex + i*2, "%02x", digest[i]);
    hex[32] = 0;
    return 0;
}

/* ── 目标进程内存读写 ── */
#include <sys/uio.h>
static int read_mem(pid_t pid, unsigned long addr, void *buf, size_t len) {
    struct iovec l = { buf, len }, r = { (void *)addr, len };
    return process_vm_readv(pid, &l, 1, &r, 1, 0) == (ssize_t)len ? 0 : -1;
}
static int write_mem(pid_t pid, unsigned long addr, const void *buf, size_t len) {
    struct iovec l = { (void *)buf, len };
    struct iovec r = { (void *)addr, len };
    return process_vm_writev(pid, &l, 1, &r, 1, 0) == (ssize_t)len ? 0 : -1;
}

static FILE *fopen_proc_maps(pid_t pid) {
    char p[64];
    snprintf(p, sizeof(p), "/proc/%d/maps", pid);
    return fopen(p, "r");
}

/* 在目标 libc 的全部可执行映射内扫 "syscall"（0f 05）指令（映射碎片化需逐段扫） */
static int find_syscall_insn(pid_t pid, unsigned long *out) {
    char line[512];
    FILE *f = fopen_proc_maps(pid);
    if (!f) return -1;
    while (fgets(line, sizeof(line), f)) {
        if (!strstr(line, "libc.so.6") || !strstr(line, "x")) continue;
        unsigned long s, e; char perms[8];
        if (sscanf(line, "%lx-%lx %7s", &s, &e, perms) != 3 || !strchr(perms, 'x')) continue;
        size_t chunk = 0x10000;
        unsigned char *buf = malloc(chunk);
        int found = 0;
        for (unsigned long a = s; a < e && !found; a += chunk - 1) {
            size_t n = (e - a < chunk) ? (size_t)(e - a) : chunk;
            if (read_mem(pid, a, buf, n) < 0) break;
            for (size_t i = 0; i + 1 < n; i++)
                if (buf[i] == 0x0f && buf[i + 1] == 0x05) { *out = a + i; found = 1; break; }
        }
        free(buf);
        if (found) { fclose(f); return 0; }
    }
    fclose(f);
    return -1;
}

/* 微信 ELF load base（最低地址段）+ 空闲受害者线程（非主线程、状态 S） */
static int find_target(pid_t pid, unsigned long *wechat_base, pid_t *victim) {
    char line[512];
    FILE *f = fopen_proc_maps(pid);
    if (!f) return -1;
    while (fgets(line, sizeof(line), f)) {
        if (strstr(line, "/opt/wechat/wechat")) {
            unsigned long s;
            if (sscanf(line, "%lx-", &s) == 1) { *wechat_base = s; break; }
        }
    }
    fclose(f);
    if (!*wechat_base) return -1;
    char tp[64];
    snprintf(tp, sizeof(tp), "/proc/%d/task", pid);
    DIR *d = opendir(tp);
    if (!d) return -1;
    *victim = 0;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
        int tid = atoi(e->d_name);
        if (tid == pid) continue;
        char sp[96], statline[1024];
        snprintf(sp, sizeof(sp), "/proc/%d/task/%d/stat", pid, tid);
        FILE *sf = fopen(sp, "r");
        if (!sf) continue;
        size_t n = fread(statline, 1, sizeof(statline) - 1, sf);
        fclose(sf);
        statline[n] = 0;
        char *rp = strrchr(statline, ')');
        if (rp && rp[2] == 'S') { *victim = tid; break; }
    }
    closedir(d);
    return *victim ? 0 : -1;
}

/* 不用 pidof：sysvinit 的 pidof 实为 killall5 符号链接，会跳过与调用者同 session 的进程
 * （wechat 与 weflow 同由 start.sh 拉起、同 session），导致从 weflow 内调用永远找不到。
 * 改为直接扫 /proc/<pid>/exe 精确匹配，零 fork，对任何调用方上下文稳定。 */
static pid_t discover_wechat_pid(void) {
    DIR *d = opendir("/proc");
    if (!d) return 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
        char p[64], buf[512];
        snprintf(p, sizeof(p), "/proc/%s/exe", e->d_name);
        ssize_t n = readlink(p, buf, sizeof(buf) - 1);
        if (n <= 0) continue;
        buf[n] = 0;
        if (strcmp(buf, WECHAT_PATH) == 0) { closedir(d); return (pid_t)atoi(e->d_name); }
    }
    closedir(d);
    return 0;
}

static void print_json(int success, long ret, const char *err) {
    if (success)
        printf("{\"success\":true,\"ret\":%ld}\n", ret);
    else
        printf("{\"success\":false,\"error\":\"%s\"}\n", err);
}

/* 注入总时限守卫：任何阶段挂死则自杀退出（调用方有超时，双保险） */
static void on_alarm(int sig) { (void)sig; print_json(0, 0, "timeout"); _exit(4); }

int main(int argc, char **argv) {
    signal(SIGALRM, on_alarm);
    if (argc < 5) {
        fprintf(stderr, "usage: %s <fileKey_hex> <aesKey> <fileLen> <savePath> [taskname] [--probe]\n", argv[0]);
        return 2;
    }
    const char *filekey = argv[1];
    const char *aeskey = argv[2];
    unsigned long filelen = strtoul(argv[3], NULL, 10);
    const char *savepath = argv[4];
    const char *taskname = (argc > 5 && argv[5][0] != '-' && strcmp(argv[5], "--probe") != 0) ? argv[5] : "cdndirect";
    int probe_only = 0;
    for (int i = 5; i < argc; i++) if (strcmp(argv[i], "--probe") == 0) probe_only = 1;
    alarm(60);

    /* 守卫 1：wechat 版本（RVA 有效性前提） */
    char hex[33];
    if (md5_file(WECHAT_PATH, hex) < 0) { print_json(0, 0, "wechat_md5_unreadable"); return 3; }
    if (strcmp(hex, WECHAT_MD5) != 0) {
        fprintf(stderr, "[cdn_fetch] wechat md5 %s != expected %s\n", hex, WECHAT_MD5);
        print_json(0, 0, "wechat_md5_mismatch"); return 3;
    }
    /* 守卫 2：目标进程 */
    pid_t pid = discover_wechat_pid();
    if (!pid) { print_json(0, 0, "wechat_not_running"); return 3; }

    unsigned long wbase; pid_t victim;
    if (find_target(pid, &wbase, &victim) < 0) { print_json(0, 0, "find_target_failed"); return 1; }
    fprintf(stderr, "[cdn_fetch] pid=%d base=0x%lx victim=%d\n", pid, wbase, victim);

    if (ptrace(PTRACE_ATTACH, victim, NULL, NULL) < 0) { print_json(0, 0, "attach_failed"); return 1; }
    int st; waitpid(victim, &st, 0);

    struct user_regs_struct orig, r;
    if (ptrace(PTRACE_GETREGS, victim, NULL, &orig) < 0) {
        ptrace(PTRACE_DETACH, victim, NULL, NULL);
        print_json(0, 0, "getregs_failed"); return 1;
    }
    unsigned long syscall_addr;
    if (find_syscall_insn(pid, &syscall_addr) < 0) {
        ptrace(PTRACE_DETACH, victim, NULL, NULL);
        print_json(0, 0, "syscall_insn_not_found"); return 1;
    }

    /* 远程 mmap（RWX，64KB） */
    r = orig;
    r.rax = 9; r.rdi = 0; r.rsi = 0x10000; r.rdx = 7; r.r10 = 0x22; r.r8 = (unsigned long)-1; r.r9 = 0;
    r.rip = syscall_addr;
    if (ptrace(PTRACE_SETREGS, victim, NULL, &r) < 0) { print_json(0, 0, "setregs_mmap"); return 1; }
    if (ptrace(PTRACE_SINGLESTEP, victim, NULL, NULL) < 0) { print_json(0, 0, "step_mmap"); return 1; }
    waitpid(victim, &st, 0);
    if (ptrace(PTRACE_GETREGS, victim, NULL, &r) < 0) { print_json(0, 0, "getregs_mmap"); return 1; }
    unsigned long page = r.rax;
    if (page == 0 || page < 0x10000 || (page & 0xFFFUL) != 0) {
        ptrace(PTRACE_SETREGS, victim, NULL, &orig);
        ptrace(PTRACE_DETACH, victim, NULL, NULL);
        print_json(0, 0, "remote_mmap_bad_page"); return 1;
    }
    fprintf(stderr, "[cdn_fetch] remote page=0x%lx\n", page);

    /* 远程页：+0x10 ret-trap / +0x100 stub / +0x200 vtable[24] / +0x300 cbobj / +0x400 strings / +0x900 param */
    unsigned long RETTRAP = page + 0x010, STUB = page + 0x100, VTAB = page + 0x200;
    unsigned long CBOBJ = page + 0x300, STRDATA = page + 0x400, PARAM = page + 0x900;
    unsigned char cc = 0xCC;
    unsigned char stub[] = {0xB8, 0x01, 0x00, 0x00, 0x00, 0xC3};
    int werr = 0;
    werr |= write_mem(pid, RETTRAP, &cc, 1);
    werr |= write_mem(pid, STUB, stub, sizeof(stub));
    unsigned long vtab[24];
    for (int i = 0; i < 24; i++) vtab[i] = STUB;
    werr |= write_mem(pid, VTAB, vtab, sizeof(vtab));
    unsigned long cb0 = VTAB;
    werr |= write_mem(pid, CBOBJ, &cb0, 8);
    if (werr) {
        ptrace(PTRACE_SETREGS, victim, NULL, &orig);
        ptrace(PTRACE_DETACH, victim, NULL, NULL);
        print_json(0, 0, "write_stub_failed"); return 1;
    }

    /* libc++ long-form string：{cap<<1|1, len, ptr} */
    struct { unsigned long off; const char *s; } strs[] = {
        {0x40, taskname}, {0x58, filekey}, {0x70, aeskey}, {0x88, savepath},
    };
    unsigned long sp = STRDATA;
    for (size_t i = 0; i < sizeof(strs) / sizeof(strs[0]); i++) {
        size_t len = strlen(strs[i].s);
        unsigned long saddr = sp;
        if (write_mem(pid, saddr, strs[i].s, len + 1) < 0) werr = 1;
        unsigned long cap = ((len + 1) << 1) | 1;
        if (write_mem(pid, PARAM + strs[i].off, &cap, 8) < 0) werr = 1;
        unsigned long l = len;
        if (write_mem(pid, PARAM + strs[i].off + 8, &l, 8) < 0) werr = 1;
        if (write_mem(pid, PARAM + strs[i].off + 16, &saddr, 8) < 0) werr = 1;
        sp += (len + 16) & ~7UL;
    }
    unsigned long cbobj = CBOBJ;
    if (write_mem(pid, PARAM, &cbobj, 8) < 0) werr = 1;
    unsigned int mt = 2, ap = 0xFFFFFFFFu;
    if (write_mem(pid, PARAM + 0xa0, &mt, 4) < 0) werr = 1;
    if (write_mem(pid, PARAM + 0xa4, &ap, 4) < 0) werr = 1;
    if (write_mem(pid, PARAM + 0x148, &filelen, 8) < 0) werr = 1;
    if (werr) {
        ptrace(PTRACE_SETREGS, victim, NULL, &orig);
        ptrace(PTRACE_DETACH, victim, NULL, NULL);
        print_json(0, 0, "write_param_failed"); return 1;
    }

    if (probe_only) {
        unsigned long cap0 = 0;
        unsigned char magic[16], back[16];
        memset(magic, 0xA5, sizeof(magic));
        int ok = write_mem(pid, sp, magic, sizeof(magic)) == 0 &&
                 read_mem(pid, sp, back, sizeof(back)) == 0 &&
                 memcmp(magic, back, sizeof(magic)) == 0 &&
                 read_mem(pid, PARAM + 0x58, &cap0, 8) == 0 &&
                 (cap0 & 1) == 1 && (cap0 >> 1) > strlen(filekey);
        fprintf(stderr, "[cdn_fetch] probe %s (cap0=0x%lx)\n", ok ? "OK" : "FAIL", cap0);
        ptrace(PTRACE_SETREGS, victim, NULL, &orig);
        ptrace(PTRACE_DETACH, victim, NULL, NULL);
        if (ok) print_json(1, 0, NULL);
        else print_json(0, 0, "probe_verify_failed");
        return ok ? 0 : 1;
    }

    /* 劫持线程调用 StartC2CDownload(param)；产物由微信 CDN 线程异步落盘 */
    r = orig;
    r.rsp -= 8;
    if (write_mem(pid, r.rsp, &RETTRAP, 8) < 0) { print_json(0, 0, "write_retaddr"); return 1; }
    r.rdi = PARAM;
    r.rip = wbase + RVA_START_C2C;
    r.rax = 0;
    if (ptrace(PTRACE_SETREGS, victim, NULL, &r) < 0) { print_json(0, 0, "setregs_call"); return 1; }
    if (ptrace(PTRACE_CONT, victim, NULL, NULL) < 0) { print_json(0, 0, "cont_call"); return 1; }
    waitpid(victim, &st, 0);

    long ret = -9999;
    int trapped = 0;
    if (WIFSTOPPED(st) && (WSTOPSIG(st) == SIGTRAP || WSTOPSIG(st) == SIGSEGV)) {
        struct user_regs_struct rr;
        if (ptrace(PTRACE_GETREGS, victim, NULL, &rr) == 0) { ret = (long)rr.rax; trapped = 1; }
    }
    fprintf(stderr, "[cdn_fetch] call trapped=%d ret=%ld\n", trapped, ret);

    ptrace(PTRACE_SETREGS, victim, NULL, &orig);
    ptrace(PTRACE_DETACH, victim, NULL, NULL);

    if (!trapped) { print_json(0, 0, "call_no_trap"); return 1; }
    print_json(1, ret, NULL);
    return 0;
}
