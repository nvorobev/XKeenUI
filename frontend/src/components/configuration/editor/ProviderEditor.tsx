import { indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { setDiagnostics } from '@codemirror/lint'
import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { showToast } from '../../../lib/store'
import { formatWithPrettier } from './format'
import { editorHighlight, editorTheme, getLanguageExtension } from './highlighting'
import { SearchPanel } from './search/SearchPanel'
import { createSearchExtension } from './search/searchExtension'
import { baseSetupNoFold } from './setup'
import { useEditorSearch } from './useEditorSearch'
import { validateByLanguage } from './validation'

export type ProviderEditorLanguage = 'yaml' | 'text' | 'json'

export interface ProviderEditorHandle {
  format: () => Promise<void>
}

interface Props {
  content: string
  language: ProviderEditorLanguage
  onChange: (value: string) => void
  onSave: () => void
  onValidationChange: (error?: string) => void
  /** Перенос длинных строк в редакторе (по умолчанию включён). */
  lineWrap?: boolean
  readOnly?: boolean
}

/** Валидация через общую логику редактора (как в основном CodeMirror из ConfigPanel). */
function validateView(view: EditorView, language: ProviderEditorLanguage) {
  const result = validateByLanguage(view.state.doc.toString(), language)
  view.dispatch(setDiagnostics(view.state, result.diagnostics))
  return result.error
}

export const ProviderEditor = forwardRef<ProviderEditorHandle, Props>(function ProviderEditor(
  { content, language, onChange, onSave, onValidationChange, lineWrap = true, readOnly = false },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartmentRef = useRef(new Compartment())
  const latestRef = useRef({ language, onChange, onSave, onValidationChange })
  latestRef.current = { language, onChange, onSave, onValidationChange }
  const [initialContent] = useState(content)
  const [initialReadOnly] = useState(readOnly)
  const lineWrapCompartmentRef = useRef(new Compartment())
  // Перенос строк переключается без пересоздания редактора (эффект ниже).
  const lineWrapRef = useRef(lineWrap)
  const readOnlyCompartmentRef = useRef(new Compartment())
  const { searchPanel, bridge } = useEditorSearch(viewRef)

  const format = useCallback(async () => {
    const view = viewRef.current
    if (!view || view.state.readOnly) return
    const content = view.state.doc.toString()
    const document = view.state.doc
    if (!content.trim()) return
    try {
      const formatted = await formatWithPrettier(content, latestRef.current.language, view.state.selection.main.head)
      if (view.state.readOnly || viewRef.current !== view || view.state.doc !== document) return
      if (!formatted || formatted.text === content) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: formatted.text },
        selection: EditorSelection.cursor(Math.min(formatted.cursor, formatted.text.length)),
        scrollIntoView: true,
      })
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Не удалось отформатировать файл', 'error')
    }
  }, [])

  const formatRef = useRef(format)
  useLayoutEffect(() => {
    formatRef.current = format
  })

  useImperativeHandle(ref, () => ({ format: () => formatRef.current() }), [])

  useEffect(() => {
    if (!containerRef.current) return

    const view = new EditorView({
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          readOnlyCompartmentRef.current.of([EditorState.readOnly.of(initialReadOnly), EditorView.editable.of(!initialReadOnly)]),
          ...baseSetupNoFold,
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-s',
                scope: 'editor search-panel',
                run: () => {
                  latestRef.current.onSave()
                  return true
                },
              },
              {
                key: 'Shift-Alt-f',
                run: () => {
                  void formatRef.current()
                  return true
                },
              },
            ])
          ),
          keymap.of([indentWithTab]),
          lineWrapCompartmentRef.current.of(lineWrapRef.current ? EditorView.lineWrapping : []),
          createSearchExtension(bridge),
          lineNumbers({ formatNumber: (lineNumber) => String(lineNumber).padStart(3, '\u00a0') }),
          indentationMarkers(),
          syntaxHighlighting(editorHighlight),
          languageCompartmentRef.current.of(getLanguageExtension(latestRef.current.language)),
          editorTheme(window.innerWidth < 768, document.documentElement.classList.contains('dark')),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            latestRef.current.onChange(update.state.doc.toString())
            latestRef.current.onValidationChange(validateView(update.view, latestRef.current.language))
          }),
        ],
      }),
      parent: containerRef.current,
    })
    viewRef.current = view

    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [initialContent, initialReadOnly, bridge])

  useEffect(() => {
    lineWrapRef.current = lineWrap
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: lineWrapCompartmentRef.current.reconfigure(lineWrap ? EditorView.lineWrapping : []) })
  }, [lineWrap])

  useEffect(() => {
    const view = viewRef.current
    if (!readOnly || !view || view.state.doc.toString() === content) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
  }, [content, readOnly])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    })
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: languageCompartmentRef.current.reconfigure(getLanguageExtension(language)) })
    latestRef.current.onValidationChange(validateView(view, language))
  }, [language])

  return (
    <div ref={containerRef} className="h-full w-full">
      {searchPanel && createPortal(<SearchPanel handle={searchPanel} replaceEnabled={!readOnly} />, searchPanel.dom)}
    </div>
  )
})
