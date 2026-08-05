import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Clapperboard, Film, ImageIcon, Sparkles } from 'lucide-react'
import ImageGenerator from '@/components/ImageGenerator'
import VideoGenerator from '@/components/VideoGenerator'
import OmniStudio from '@/components/OmniStudio'
import SeedanceStudio from '@/components/SeedanceStudio'
import { getSeedanceCapabilitiesFn } from '@/lib/server-functions'

type Tab = 'image' | 'video' | 'omni' | 'seedance'

function VisualPage() {
  const capabilities = Route.useLoaderData()
  const [activeTab, setActiveTab] = useState<Tab>('image')
  const [lastGeneratedImage, setLastGeneratedImage] = useState<string | null>(
    null,
  )

  return (
    <div className="min-h-[calc(100vh-72px)] bg-gray-900 p-6">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">
            Visual Content Generator
          </h1>
          <p className="text-gray-400">
            Generate images and videos using AI models
          </p>
        </div>

        <div className="flex flex-wrap gap-2 mb-6">
          <button
            type="button"
            onClick={() => setActiveTab('image')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'image'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            <ImageIcon className="w-5 h-5" />
            Image
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('video')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'video'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            <Film className="w-5 h-5" />
            Video
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('omni')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'omni'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            <Sparkles className="w-5 h-5" />
            Omni Studio
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('seedance')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'seedance'
                ? 'bg-cyan-600 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            <Clapperboard className="w-5 h-5" />
            Seedance Studio
          </button>
        </div>

        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
          {activeTab === 'image' ? (
            <ImageGenerator onImageGenerated={setLastGeneratedImage} />
          ) : activeTab === 'video' ? (
            <VideoGenerator initialImageUrl={lastGeneratedImage} />
          ) : activeTab === 'omni' ? (
            <OmniStudio />
          ) : (
            <SeedanceStudio capabilities={capabilities} />
          )}
        </div>
      </div>
    </div>
  )
}

function VisualPageError({ error }: { error: Error }) {
  return (
    <div className="min-h-[calc(100vh-72px)] bg-gray-900 p-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-white mb-2">
          Visual Content Generator
        </h1>
        <div className="mt-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
          <p className="text-red-400 text-sm">
            Could not load Seedance capability metadata from{' '}
            <code>@tanstack/ai-byteplus</code>: {error.message}
          </p>
          <p className="text-gray-400 text-sm mt-2">
            The Seedance Studio tab drives its controls off that table. Rebuild
            the workspace packages and check{' '}
            <code>getSeedanceCapabilitiesFn</code> against the current{' '}
            <code>availableDurations()</code> contract.
          </p>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/')({
  // Capability table is static adapter metadata — load once for the Seedance
  // tab instead of a separate route (same pattern as the former /seedance
  // loader).
  loader: () => getSeedanceCapabilitiesFn(),
  component: VisualPage,
  errorComponent: VisualPageError,
})
