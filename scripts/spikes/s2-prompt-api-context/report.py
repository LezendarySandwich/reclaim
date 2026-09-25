#!/usr/bin/env python3
"""Print and interpret S2 probe results. Standalone so results can be re-read without re-running."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, 'results.jsonl')

EXTENSION_CONTEXTS = {'SERVICE_WORKER', 'OFFSCREEN', 'EXTENSION_PAGE', 'CONTENT_ISOLATED', 'WORKER'}


def load():
    rows = []
    if not os.path.exists(PATH):
        return rows
    with open(PATH) as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


def main():
    rows = load()
    if not rows:
        print('NO RESULTS in results.jsonl. Check chrome.log — Chrome may not have launched.')
        return 1

    print('\n==================== RESULTS ====================\n')
    seen = set()
    for d in rows:
        key = (d.get('ctx'), d.get('label'), d.get('href'))
        if key in seen:
            continue
        seen.add(key)
        pp = d.get('ppAllowsLanguageModel', d.get('ppAllows'))
        print(
            f"{str(d.get('ctx', '?')):20} LM={str(d.get('typeofLanguageModel')):10} "
            f"avail={str(d.get('availability')):13} pp={str(pp):6} "
            f"gpu={str(d.get('gpuAdapter', d.get('hasWebGPU'))):16} "
            f"secure={d.get('isSecureContext')}"
        )
        href = str(d.get('href', ''))
        if href:
            print(f"      {href.split(':8443')[-1][:70] or href[:70]}")
        for k in ('adapterInfo', 'createError', 'availabilityError', 'gpuError',
                  'answer', 'createMs', 'promptMs'):
            if d.get(k) is not None:
                print(f'      {k}: {d[k]}')

    present = {d.get('ctx') for d in rows}
    print('\n---------------- WHAT THIS MEANS ----------------\n')

    # --- Permissions-Policy: answerable from page contexts alone -------------------------------
    pages = [d for d in rows if d.get('ctx') == 'PAGE_INLINE']
    by_page = {str(d.get('href', '')).rstrip('/').split('/')[-1]:
               d.get('ppAllows', d.get('ppAllowsLanguageModel')) for d in pages}
    if len(set(by_page.values())) > 1:
        print('PERMISSIONS-POLICY  CONFIRMED — a host page controls the Prompt API via one header.')
        print(f'                    {by_page}')
        print('                    A site can disable it with: Permissions-Policy: language-model=()')
        print('                    -> Reinforces ADR-009: never host the model in a content script.')
    elif by_page:
        print(f'PERMISSIONS-POLICY  inconclusive: {by_page}')

    # --- The actual blocking question ----------------------------------------------------------
    missing = EXTENSION_CONTEXTS - present
    if missing:
        print()
        print('EXTENSION CONTEXTS  NOT MEASURED — no report from: ' + ', '.join(sorted(missing)))
        print('                    The blocking question (does LanguageModel + WebGPU work in an')
        print('                    OFFSCREEN document?) is still open. ADR-009 stays provisional.')
        print('                    Chrome ignores --load-extension; load ext/ manually — see README.')
        return 2

    off = next((d for d in rows if d.get('ctx') == 'OFFSCREEN'), None)
    if off:
        lm_ok = off.get('typeofLanguageModel') not in (None, 'undefined')
        gpu_ok = bool(off.get('gpuAdapter') or off.get('hasWebGPU'))
        print(f"OFFSCREEN           LanguageModel: {'YES' if lm_ok else 'NO'}   "
              f"WebGPU: {'YES' if gpu_ok else 'NO'}")
        if lm_ok and gpu_ok:
            print('                    -> ADR-009 CONFIRMED. Build the model layer in the')
            print('                       offscreen document.')
        else:
            print('                    -> ADR-009 FAILS. Move the model host to an extension page')
            print('                       or side panel. Update decisions.md before writing any')
            print('                       engine code.')
        info = str(off.get('adapterInfo', '')).lower()
        if 'swiftshader' in info or 'llvmpipe' in info:
            print('                    -> WARNING: software renderer, not a real GPU. WebLLM is')
            print('                       not viable on this setup.')

    sw = next((d for d in rows if d.get('ctx') == 'SERVICE_WORKER'), None)
    if sw:
        got = sw.get('typeofLanguageModel')
        expected = got in (None, 'undefined')
        print(f"SERVICE WORKER      LanguageModel: {got}  "
              f"({'as expected' if expected else 'UNEXPECTED — re-check the worker gate'})")

    cs = [d for d in rows if d.get('ctx') == 'CONTENT_ISOLATED']
    if len(cs) >= 2:
        vals = {str(d.get('href', '')).rstrip('/').split('/')[-1]:
                d.get('ppAllowsLanguageModel', d.get('ppAllows')) for d in cs}
        print(f'CONTENT SCRIPT      Permissions-Policy by page: {vals}')
        if len(set(vals.values())) > 1:
            print('                    -> An isolated world DOES inherit the host page policy.')
            print('                       LinkedIn holds a kill switch over content-script inference.')
        else:
            print('                    -> Isolated world appears immune to the host page policy.')
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
